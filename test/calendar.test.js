// The calendar plugin's tests need no DSH, so they run here with the others: the store, repeats and
// zones, the write rules, and CalDAV, Google and Microsoft against stand-in servers. The CalDAV tests
// against a real Radicale server run when RADICALE_VENV or RADICALE_PYTHON points at one.
// Its tests on a real DSH are `npm run test:e2e:calendar` and, for the window, `npm run test:e2e:calendar-ui`.
import '../plugins/calendar/test/manager.test.mjs';
import '../plugins/calendar/test/store.test.mjs';
import '../plugins/calendar/test/policy.test.mjs';
import '../plugins/calendar/test/caldav.test.mjs';
import '../plugins/calendar/test/http.test.mjs';
import '../plugins/calendar/test/google.test.mjs';
import '../plugins/calendar/test/microsoft.test.mjs';
import '../plugins/calendar/test/ical.test.mjs';
import '../plugins/calendar/test/client.mjs';
