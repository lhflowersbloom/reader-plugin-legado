// ---------------------------------------------------------------------------
// Process hardening (imported first by index.js)
//
// Book-source scripts run in node:vm, which is NOT a security boundary: a
// script can climb out to the host realm (for example through a host function's
// `constructor`) and reach `process`. Imported book sources come from the
// internet, so remove the process APIs that would turn such an escape into
// file-system / child-process / native-addon access. The plugin itself only
// uses static ESM imports and never needs them.
//
// This is defence in depth, not a sandbox: an escaped script can still use the
// network (as java.ajax already allows) and read process.env.
// ---------------------------------------------------------------------------
const BLOCKED = ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen'];

export const hardened = [];

for (const name of BLOCKED) {
  if (!(name in process)) continue;
  const blocked = () => {
    throw new Error(`process.${name} is disabled in the Legado plugin`);
  };
  try {
    Object.defineProperty(process, name, { value: blocked, writable: false, configurable: false, enumerable: false });
    hardened.push(name);
  } catch {
    try {
      process[name] = blocked;
      if (process[name] === blocked) hardened.push(name);
    } catch {
      // leave as is
    }
  }
}
