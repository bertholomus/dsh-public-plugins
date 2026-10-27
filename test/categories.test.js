// The categories plugin's browser half: its tests need no DSH, so they run here with the others.
// The host half's tests run from categories-host.test.js (plugins/categories/test/smoke.mjs, with DSH's packages).
import '../plugins/categories/test/client.mjs';
