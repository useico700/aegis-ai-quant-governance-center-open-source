export const V4_STOP_ID = "OWNER-DIRECTIVE-ORION-V4-STOP-20260909";

export function validateV4OwnerStop({ current, authorization, scanner, supervisor, marker, processAlive }) {
  const errors = [];
  const stop = current?.orionV4OwnerStop ?? {};
  const governed = current?.orionV4RangeResearch ?? {};
  const domain = current?.executionDomains?.orionV4RangeResearch ?? {};
  if (stop.status !== "STOPPED_BY_OWNER" || stop.authorizationId !== V4_STOP_ID ||
      authorization?.id !== V4_STOP_ID || authorization?.status !== "ACTIVE" ||
      authorization?.scope?.newEntriesAllowed !== false || authorization?.scope?.automaticRestartAllowed !== false ||
      stop.restartRequiresNewOwnerAuthorization !== true || stop.automaticRestartAllowed !== false) errors.push("V4_STOP_AUTHORIZATION_INVALID");
  for (const entry of [governed, domain]) {
    if (entry.status !== "STOPPED_BY_OWNER" || entry.executionAuthorizationId !== V4_STOP_ID ||
        ["residentScannerAllowed", "matchingEngineOrderSubmissionAllowed", "testnetOrdersAllowed", "forwardPaperOrdersAllowed", "orderTestEndpointAllowed", "initialLeverageAlignmentAllowed", "realOrdersAllowed"].some((key) => entry[key] !== false)) errors.push("V4_STOP_EXECUTION_BOUNDARY_INVALID");
  }
  if (JSON.stringify(domain.allowedMethods) !== '["GET"]' || JSON.stringify(governed.signedRequestMethods) !== '["GET"]' ||
      governed.strategyExecutionActivationStatus !== "STOPPED_BY_OWNER" ||
      current?.agents?.find((agent) => agent.id === "orion-v4")?.lifecycle !== "STOPPED_BY_OWNER") errors.push("V4_STOP_LIFECYCLE_INVALID");
  if (scanner?.status !== "STOPPED" || supervisor?.status !== "STOPPED" ||
      !Number.isInteger(scanner?.pid) || !Number.isInteger(supervisor?.pid) ||
      processAlive(scanner.pid) || processAlive(supervisor.pid) || !marker?.requestedAt || !scanner?.stoppedAt) errors.push("V4_STOP_RUNTIME_NOT_VERIFIED");
  return errors;
}
