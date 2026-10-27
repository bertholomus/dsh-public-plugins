/**
 * dsh-plugin-notifications-e2e-caller — a stand-in caller for the
 * notifications plugin's real-DSH test (tests only). It takes the
 * notifications service exactly as the coordinator, Decisions and Fleet do
 * (`ctx.inject(['notifications'], …)`) and serves one window endpoint,
 * `dsh-plugin-notifications-e2e-caller/notify`, that passes a notification
 * on and answers what the service said ('absent' while the service is not
 * there: the plugin is off or not loaded).
 *
 * @module dsh-plugin-notifications-e2e-caller
 */
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';

export const name = 'notifications-e2e-caller';
export const inject = [];

const SERVICE = 'dshPluginNotificationsE2eCallerRemote';

class CallerRemote {
    constructor(service) {
        this.service = service;
        this.typertRemote = bindTypertRemote(this, SERVICE, { namespace: 'dsh-plugin-notifications-e2e-caller' });
    }

    async notify(notification) {
        const service = this.service();
        return service ? service.notify(notification) : 'absent';
    }
}

for (const method of ['notify']) {
    Remote(CallerRemote.prototype[method], {
        kind: 'method', name: method, static: false, private: false,
        addInitializer(init) { init.call(Object.create(CallerRemote.prototype)); },
    });
}

export function apply(ctx) {
    let service;
    ctx.inject(['notifications'], (scope) => {
        const found = scope.notifications;
        service = found;
        return () => { if (service === found) service = undefined; };
    });
    ctx.inject(['typertGateway'], (scope) => {
        scope.provide(SERVICE, new CallerRemote(() => service));
    });
}
