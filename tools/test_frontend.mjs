/** Unit tests of the production patches with network/navigation boundaries.
 * Uses Odoo 19's actual patch implementation, not a replacement implementation.
 * This is not an end-to-end browser test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const odooRoot = process.env.ODOO_ROOT || '/workspace/odoo19';
const patchCode = readFileSync(`${odooRoot}/addons/web/static/src/core/utils/patch.js`, 'utf8').replaceAll('export ', '');
const concurrencyCode = readFileSync(`${odooRoot}/addons/web/static/src/core/utils/concurrency.js`, 'utf8').replaceAll('export ', '');
const code = readFileSync(`${root}/alvina_pos_employee_discount/static/src/app/employee_discount_validation.js`, 'utf8').replace(/^import .*;\n/gm, '');

function fixture() {
    class PosOrder {
        removeOrderline() {} setPricelist() {} setPartner() {}
        get finalized() { return this.state !== 'draft'; }
        assertEditable() { if (this.finalized) { throw new Error('Finalized'); } return true; }
        get canBeRemovedFromIndexedDB() { return this.state !== 'draft' && typeof this.id === 'number'; }
        get isUnsyncedPaid() { return this.state !== 'draft' && typeof this.id !== 'number'; }
    }
    class PosOrderline {
        setQuantity(qty) { this.qty = qty; }
        setUnitPrice(price) { this.price_unit = price; }
        setDiscount(rate) { this.discount = rate; }
    }
    class PosStore {
        async addLineToOrder() {}
        async syncAllOrders() { return this.syncBehavior ? this.syncBehavior() : [this.order]; }
    }
    class OrderPaymentValidation {
        async validateOrder() { this.finalizeCalls++; await this.shouldHideValidationBehindFeedbackScreen(); }
        async finalizeValidation() {
            this.order.state = 'paid';
            if (this.failFinalize) { return this.handleValidationError(this.failFinalize); }
            this.serverStatus.confirmed = true;
            this.serverStatus.state = 'paid';
            this.order.alvina_confirmed = true;
        }
        async shouldHideValidationBehindFeedbackScreen() { this.pos.navigate('standard'); }
        handleValidationError() { this.offlineFallback = true; }
    }
    const context = vm.createContext({ PosOrder, PosOrderline, PosStore, OrderPaymentValidation, AlertDialog: class {} });
    vm.runInContext(concurrencyCode + '\n' + patchCode + '\n' + code, context);
    const order = Object.assign(new PosOrder(), { state: 'draft', uuid: 'order', id: 1,
        alvina_operation: 'order', alvina_amount: 15, alvina_confirmed: false, lines: [] });
    const line = Object.assign(new PosOrderline(), { order_id: order, discount: 15, price_unit: 100, qty: 1 });
    order.lines = [line];
    const calls = [], navigations = [], alerts = [];
    const serverStatus = { confirmed: false, state: 'draft', id: 1 };
    let persisted = 0;
    const store = Object.assign(new PosStore(), {
        data: { network: { offline: false }, localUnsyncedPaidOrderUuids: new Set(),
            synchronizeLocalDataInIndexedDB: async () => { persisted++; }, read: async () => {}, call: async (_model, method) => {
            calls.push(method); return { ...serverStatus };
        } },
        order, addPendingOrder() {}, removePendingOrder() {}, numberBuffer: { capture() {} },
        dialog: { add: (_dialog, props) => alerts.push(props) },
        navigate: (...args) => navigations.push(args),
        env: { services: { ui: { block() {}, unblock() {} } } },
    });
    const validation = Object.assign(new OrderPaymentValidation(), { order, pos: store, finalizeCalls: 0, serverStatus });
    return { order, line, store, validation, calls, navigations, alerts, serverStatus, get persisted() { return persisted; } };
}

test('offline benefit cannot reach payment finalization or receipt', async () => {
    const f = fixture(); f.store.data.network.offline = true;
    assert.equal(await f.validation.validateOrder(), false);
    assert.equal(f.validation.finalizeCalls, 0);
    assert.equal(f.navigations.length, 0);
    assert.equal(f.alerts.length, 1);
});
test('server refusal prevents payment finalization', async () => {
    const f = fixture(); f.store.data.call = async () => { throw new Error('Expired'); };
    await f.validation.validateOrder();
    assert.equal(f.validation.finalizeCalls, 0);
    assert.equal(f.navigations.length, 0);
});
test('lost payment response never enables the standard offline fallback', async () => {
    const f = fixture(); f.validation.failFinalize = new Error('Connection lost');
    await f.validation.validateOrder();
    assert.equal(f.navigations.length, 0);
    assert.equal(f.validation.offlineFallback, undefined);
    assert.equal(f.alerts.length, 1);
});
test('quantity changes remove stale discount and require reauthorization', async () => {
    const f = fixture(); f.line.setQuantity(2);
    assert.equal(f.line.discount, 0); assert.equal(f.order.alvina_amount, 0);
    await f.validation.validateOrder();
    assert.equal(f.validation.finalizeCalls, 0);
});
test('manual percentage changes cannot replace the assigned benefit', () => {
    const f = fixture(); f.line.setDiscount(90);
    assert.equal(f.line.discount, 0); assert.equal(f.order._alvinaStale, true);
});
test('only internal application assigns the approved rate', () => {
    const f = fixture(); f.order._alvinaApplying = true; f.line.setDiscount(10);
    assert.equal(f.line.discount, 10); assert.equal(f.order._alvinaStale, undefined);
});
test('server confirmation is required before receipt navigation', async () => {
    const f = fixture(); await f.validation.validateOrder();
    assert.deepEqual(f.calls, ['alvina_status', 'alvina_validate', 'alvina_status']);
    assert.equal(f.navigations[0][0], 'ReceiptScreen');
});
test('ambiguous paid order checks status before any second payment', async () => {
    const f = fixture(); f.order.state = 'paid'; f.serverStatus.confirmed = true;
    await f.validation.validateOrder();
    assert.deepEqual(f.calls, ['alvina_status']);
    assert.equal(f.validation.finalizeCalls, 0);
    assert.equal(f.navigations[0][0], 'ReceiptScreen');
});

test('uncertain numeric-ID payment stays in IndexedDB and persists immediately', async () => {
    const f = fixture(); f.validation.failFinalize = new Error('Connection lost');
    await f.validation.validateOrder();
    assert.equal(f.order.state, 'paid');
    assert.equal(f.order.canBeRemovedFromIndexedDB, false);
    assert.equal(f.order.isUnsyncedPaid, true);
    assert.equal(f.persisted, 1);
});
test('draft snapshot recovers a payment already committed on the server', async () => {
    const f = fixture(); f.serverStatus.confirmed = true; f.serverStatus.state = 'paid';
    await f.validation.validateOrder();
    assert.equal(f.validation.finalizeCalls, 0);
    assert.equal(f.order.alvina_confirmed, true);
    assert.equal(f.persisted, 1);
    assert.equal(f.navigations[0][0], 'ReceiptScreen');
});
test('partner changes invalidate the reserved discount', () => {
    const f = fixture(); f.order.setPartner({id: 2});
    assert.equal(f.order.alvina_amount, 0);
    assert.equal(f.line.discount, 0);
});
test('cancelled backend order cannot be charged again', async () => {
    const f = fixture(); f.order.state = 'paid'; f.serverStatus.state = 'cancel';
    await f.validation.validateOrder();
    assert.equal(f.validation.finalizeCalls, 0);
    assert.equal(f.order.state, 'paid');
    assert.equal(f.navigations.length, 0);
});

test('foreground authorization waits for a background sync already in flight', async () => {
    const f = fixture();
    let releaseFirst, started = 0;
    f.store.syncBehavior = async () => {
        started++;
        if (started === 1) { await new Promise(resolve => { releaseFirst = resolve; }); }
        return [f.order];
    };
    const background = f.store.syncAllOrders();
    await Promise.resolve();
    const authorization = f.store.alvinaSync(f.order);
    await Promise.resolve();
    assert.equal(started, 1);
    releaseFirst();
    await Promise.all([background, authorization]);
    assert.equal(started, 2);
});
test('a failed background sync releases the mutex for subsequent authorization', async () => {
    const f = fixture();
    let attempt = 0;
    f.store.syncBehavior = async () => {
        if (++attempt === 1) { throw new Error('Interrupted'); }
        return [f.order];
    };
    await assert.rejects(f.store.syncAllOrders(), /Interrupted/);
    await f.store.alvinaSync(f.order);
    assert.equal(attempt, 2);
});

test('uncertain payment is reachable in the recovery screen but stays uneditable', () => {
    const f = fixture(); f.order.state = 'paid';
    assert.equal(f.order.finalized, false);
    assert.throws(() => f.order.assertEditable(), /pendiente de confirmación/);
    f.order.alvina_confirmed = true;
    assert.equal(f.order.finalized, true);
    assert.equal(f.order.canBeRemovedFromIndexedDB, true);
});

test('uncertain payment cannot change quantities or prices before status recovery', () => {
    const f = fixture(); f.order.state = 'paid';
    assert.throws(() => f.line.setQuantity(2), /pendiente de confirmación/);
    assert.throws(() => f.line.setUnitPrice(200), /pendiente de confirmación/);
    assert.equal(f.line.qty, 1);
    assert.equal(f.line.price_unit, 100);
});
