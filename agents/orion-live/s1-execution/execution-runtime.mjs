import { invariant } from './common.mjs';
import { ExecutionKernel } from './kernel.mjs';
import { PositionLedger } from './position-ledger.mjs';
import { PositionLifecycle } from './lifecycle.mjs';
import { S1ExecutionEngine } from './engine.mjs';
import { createExecutionTransport } from './execution-transport.mjs';
import { createExecutionAuthorization } from './execution-authorization.mjs';
import { S1Resident } from './resident.mjs';
import { createProductionOrderPort } from './transport.mjs';
import { OrderRequestBudget } from './order-request-budget.mjs';
import { assertSharedAdmissionHost, ResidentReadAdmission } from './host-admission.mjs';

// Assemble existing components; no network, credential loading, timers or
// automatic activation occurs here. The caller owns journal and port shutdown.
export function createExecutionRuntime({ journal, readPort, orderPort, createOrderPort = null, runtime,
  strategy, riskProfile, trialLimits, frameProvider, evidenceArchive, entryQualityRequired = false,
  mode = 'OBSERVE', authorizeOperation = null, residentPorts = null, now = Date.now }) {
  invariant(['OBSERVE', 'LIVE'].includes(mode) && (authorizeOperation === null || typeof authorizeOperation === 'function'), 'EXECUTION_RUNTIME_CONFIGURATION');
  const authorize = authorizeOperation ?? createExecutionAuthorization({ trialLimits });
  const book = new PositionLedger(journal);
  invariant(createOrderPort === null || (typeof createOrderPort === 'function' && orderPort === undefined), 'EXECUTION_ORDER_FACTORY_CONFLICT');
  if (createOrderPort) orderPort = createOrderPort(book);
  let kernel, engine;
  const guardedOrders = { supportsDispatchBoundary: orderPort?.supportsDispatchBoundary === true, async request(method, pathname, params, dispatch) {
    invariant(mode === 'LIVE', 'ENGINE_OBSERVE_ONLY');
    const operation = Object.freeze({ method, pathname, params: Object.freeze({ ...params }) });
    invariant(await authorize(operation) === true, 'LIVE_EXECUTION_DISARMED');
    return orderPort.request(method, pathname, operation.params, dispatch);
  } };
  invariant(typeof orderPort?.request === 'function', 'EXECUTION_ORDER_PORT_REQUIRED');
  const transport = createExecutionTransport({ readPort, orderPort: guardedOrders, getKernel: () => kernel });
  kernel = new ExecutionKernel({ journal, transport, gates: request => engine.submissionGate(request), now });
  const lifecycle = new PositionLifecycle({ kernel, book, runtime, strategy, now });
  engine = new S1ExecutionEngine({ kernel, book, lifecycle, riskProfile, trialLimits,
    mode, frameProvider, evidenceArchive, entryQualityRequired, now });
  const resident = residentPorts === null ? null : new S1Resident({ ...residentPorts, engine, book, transport, now });
  let closing = false;
  return Object.freeze({ engine, kernel, lifecycle, book, transport, resident,
    start(options) {
      invariant(resident && !closing, 'EXECUTION_RESIDENT_NOT_AVAILABLE');
      resident.start(options);
    },
    close() {
      closing = true;
      engine.pauseEntries('RESIDENT_SHUTDOWN');
      // The existing resident drains started operations and stream closures.
      // Never close the caller's journal here, including on drain failure.
      return resident ? resident.close() : Promise.resolve();
    },
  });
}

// Server-only assembly, not a CLI and not an activation operation. The caller
// supplies already-open shared admission and resources, then explicitly starts.
export function createProductionExecutionRuntime({ credentials, ipBudget,
  maximumOrders10s, maximumOrders60s, ...options }) {
  assertSharedAdmissionHost();
  invariant(ipBudget instanceof ResidentReadAdmission && !ipBudget.stopping && !ipBudget.closed,
    'PRODUCTION_SHARED_ADMISSION_REQUIRED');
  invariant(options.orderPort === undefined && options.createOrderPort === undefined
    && options.authorizeOperation === undefined, 'PRODUCTION_PORT_OVERRIDE_FORBIDDEN');
  const mutationPermit = createExecutionAuthorization({ trialLimits: options.trialLimits });
  return createExecutionRuntime({ ...options, authorizeOperation: mutationPermit,
    createOrderPort: book => createProductionOrderPort({ credentials, mutationPermit,
      orderBudget: new OrderRequestBudget({ book, ipBudget, maximumOrders10s, maximumOrders60s }) }),
  });
}
