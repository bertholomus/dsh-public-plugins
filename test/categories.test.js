// The categories plugin's browser half: its tests need no DSH, so they run here with the others.
// The host half's tests are plugins/categories/test/smoke.mjs (they need the DSH peers).
import '../plugins/categories/test/client.mjs';
