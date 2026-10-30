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
const code = readFileSync(`${root}/alvina_pos_employee_discount/static/src/app/employee_discount_validation.js`, 'utf8').replace(/^import .*;\n/gm, '');

function fixture() {
    class PosOrder { removeOrderline() {} setPricelist() {} }
    class PosOrderline {
        setQuantity(qty) { this.qty = qty; }
        setUnitPrice(price) { this.price_unit = price; }
        setDiscount(rate) { this.discount = rate; }
    }
    class PosStore { async addLineToOrder() {} }
    class OrderPaymentValidation {
        async validateOrder() { this.finalizeCalls++; await this.shouldHideValidationBehindFeedbackScreen(); }
        async finalizeValidation() { if (this.failFinalize) { this.handleValidationError(this.failFinalize); } }
        async shouldHideValidationBehindFeedbackScreen() { this.pos.navigate('standard'); }
        handleValidationError() { this.offlineFallback = true; }
    }
    const context = vm.createContext({ PosOrder, PosOrderline, PosStore, OrderPaymentValidation, AlertDialog: class {} });
    vm.runInContext(patchCode + '\n' + code, context);
    const order = Object.assign(new PosOrder(), { state: 'draft', uuid: 'order', id: 1,
        alvina_operation: 'order', alvina_amount: 15, lines: [] });
    const line = Object.assign(new PosOrderline(), { order_id: order, discount: 15, price_unit: 100, qty: 1 });
    order.lines = [line];
    const calls = [], navigations = [], alerts = [];
    const store = Object.assign(new PosStore(), {
        data: { network: { offline: false }, call: async (_model, method) => {
            calls.push(method); return { confirmed: true, id: 1 };
        } },
        addPendingOrder() {}, syncAllOrders: async () => [order],
        dialog: { add: (_dialog, props) => alerts.push(props) },
        navigate: (...args) => navigations.push(args),
        env: { services: { ui: { block() {}, unblock() {} } } },
    });
    const validation = Object.assign(new OrderPaymentValidation(), { order, pos: store, finalizeCalls: 0 });
    return { order, line, store, validation, calls, navigations, alerts };
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
    assert.deepEqual(f.calls, ['alvina_validate', 'alvina_status']);
    assert.equal(f.navigations[0][0], 'ReceiptScreen');
});
test('ambiguous paid order checks status before any second payment', async () => {
    const f = fixture(); f.order.state = 'paid'; f.store.data.read = async () => {};
    await f.validation.validateOrder();
    assert.deepEqual(f.calls, ['alvina_status']);
    assert.equal(f.validation.finalizeCalls, 0);
    assert.equal(f.navigations[0][0], 'ReceiptScreen');
});
