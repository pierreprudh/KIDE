/**
 * Hosted metadata reads do not activate a local runtime. Managed local models
 * are different: reflection/token probes can load a cold model, so a resumed
 * transcript keeps those gated until send() clears `deferred`.
 */
export function mayActivateModel({
  deferred,
  managedLocal,
}: {
  deferred: boolean;
  managedLocal: boolean;
}): boolean {
  return !deferred || !managedLocal;
}
