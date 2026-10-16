import { hash, invariant } from './common.mjs';
import { ExecutionKernel } from './kernel.mjs';
import { validateMutation } from './transport.mjs';

// Combine existing read and order ports without giving the observer write access.
// getKernel resolves the construction cycle; it never creates or approves a plan.
export function createExecutionTransport({ readPort, orderPort, getKernel }) {
  invariant(typeof readPort?.request === 'function' && typeof orderPort?.request === 'function'
    && typeof getKernel === 'function', 'EXECUTION_PORTS_REQUIRED');
  return Object.freeze({
    supportsDispatchBoundary: orderPort.supportsDispatchBoundary === true,
    async request(method, pathname, params = {}, dispatch) {
      if (method === 'GET') return readPort.request(method, pathname, params);
      validateMutation(method, pathname, params);
      const kernel = getKernel();
      invariant(kernel instanceof ExecutionKernel && !kernel.journal.failed, 'EXECUTION_KERNEL_REQUIRED');
      // Cancellation client IDs identify the order being canceled, not the
      // cancellation intent. Match the complete durable payload instead.
      const matches = [...kernel.intents.values()].filter(intent => intent.method === method
        && intent.path === pathname && hash(intent.params) === hash(params));
      invariant(matches.length === 1 && matches[0].result === null, 'DURABLE_UNOBSERVED_INTENT_REQUIRED');
      const intent = matches[0];
      if (intent.dispatchProtocol === 'MARKER_V2_NETWORK') invariant(orderPort.supportsDispatchBoundary === true
        && typeof dispatch?.beforeDispatch === 'function' && !kernel.dispatchStarted.has(intent.id), 'NETWORK_DISPATCH_BOUNDARY_REQUIRED');
      let recorded = false;
      for (const event of kernel.journal.events) {
        if (event.type === 'INTENT' && event.id === intent.id && event.method === method
          && event.path === pathname && hash(event.params) === hash(params)) { recorded = true; break; }
      }
      invariant(recorded, 'DURABLE_INTENT_RECORD_REQUIRED');
      // Authorization remains the order port's per-operation responsibility.
      return orderPort.request(method, pathname, params, dispatch);
    },
  });
}
