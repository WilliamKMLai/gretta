/**
 * Function-command runtime, loaded by commands.html via the manifest's
 * <FunctionFile> element (manifest/manifest.xml).
 *
 * GRETTA v1 defines no ExecuteFunction ribbon commands — the single ribbon
 * button uses the declarative ShowTaskpane action, which needs no script — but
 * the Office manifest schema requires a FunctionFile to exist for the desktop
 * form factor. This runtime therefore initializes and does nothing further by
 * design. Future ribbon commands (ARCHITECTURE.md §16) register here via
 * `Office.actions.associate`.
 */
void Office.onReady(() => {
  console.info('[GRETTA] command runtime ready');
});
