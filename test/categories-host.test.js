// The categories plugin's host half: its tests live with the plugin (they need DSH's own packages, which come from
// the newest runtime under .e2e/; plugins/categories/test/peers.mjs) and npm test runs them from here.
import '../plugins/categories/test/smoke.mjs';
