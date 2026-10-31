// Exercises a LOST RESPONSE AFTER COMMIT with real Odoo, IndexedDB and reload.
// Run prepare_browser_fixture.py first on a disposable *_test database.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
    const fixture = JSON.parse(fs.readFileSync(process.env.ALVINA_BROWSER_FIXTURE || '/tmp/alvina-browser-fixture.json', 'utf8'));
    assert(fixture.database.endsWith('_test'));
    const dropBeforeCommit = process.env.ALVINA_DROP_MODE === 'before_commit';
    const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
    try {
        const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
        const page = await context.newPage();
        page.on('pageerror', error => console.error('PAGE_ERROR', error.message));
        const auth = await context.request.post('http://127.0.0.1:8079/web/session/authenticate', {
            data: {jsonrpc: '2.0', method: 'call', params: {db: fixture.database, login: fixture.login, password: fixture.password}},
        });
        assert((await auth.json()).result?.uid);
        await page.goto(`http://127.0.0.1:8079/pos/ui/${fixture.config}?debug=assets`);
        await page.getByText('Unlock Register', {exact: true}).click({timeout: 30000});
        await page.getByText(fixture.product_name, {exact: true}).first().click();
        assert.equal(await page.locator('.alvina-benefit-button').count(), 0, 'Benefit belongs only in Actions');
        await page.locator('.more-btn').click();
        await page.getByRole('button', {name: 'Descuento colaborador', exact: true}).click();
        await page.locator('.control-buttons-modal').waitFor({state: 'hidden'});
        await page.locator('#alvina-dni').fill(fixture.dni);
        await page.getByRole('button', {name: 'Consultar', exact: true}).click();
        await page.locator('.modal dd').last().waitFor();
        await page.locator('.modal input[type=checkbox]').check();
        await page.getByRole('button', {name: 'APLICAR DESCUENTO', exact: true}).click();
        await page.locator('.modal').waitFor({state: 'hidden'});
        const orderUuid = await page.evaluate(() => window.posmodel.getOrder().uuid);
        let blocked = true, committed = false, interrupted = false, paidRequests = 0;
        await context.route('**/web/dataset/call_kw/pos.order/**', async route => {
            const params = route.request().postDataJSON()?.params;
            const isPaidSync = route.request().url().includes('/sync_from_ui') && params?.args?.[0]?.some(order => order.state === 'paid');
            if (isPaidSync) { paidRequests++; }
            if (blocked && isPaidSync) {
                interrupted = true;
                if (!dropBeforeCommit && !committed) {
                    const response = await route.fetch();
                    const body = await response.json();
                    assert(!body.error, JSON.stringify(body.error));
                    committed = true;
                }
                await route.abort('failed'); // Server committed; cashier receives no response.
            } else if (blocked && interrupted && route.request().url().includes('/alvina_status')) {
                await route.abort('failed'); // Keep uncertainty until after browser reload.
            } else {
                await route.continue();
            }
        });
        await page.getByText('Payment', {exact: true}).click();
        await page.getByText('Validate', {exact: true}).click();
        await page.getByText('Venta sin confirmación', {exact: true}).waitFor();
        assert(interrupted);
        assert.equal(committed, !dropBeforeCommit);
        const before = await page.evaluate(uuid => {
            const order = window.posmodel.models['pos.order'].getBy('uuid', uuid);
            return {state: order.state, removable: order.canBeRemovedFromIndexedDB, unsynced: order.isUnsyncedPaid};
        }, orderUuid);
        assert.deepEqual(before, {state: 'paid', removable: false, unsynced: true});
        assert.equal(await page.locator('.pos-receipt').count(), 0, 'An uncertain payment must not print a receipt');
        const saved = await page.evaluate(async uuid => {
            await window.posmodel.data.synchronizeLocalDataInIndexedDB();
            const records = await window.posmodel.data.indexedDB.readAll(['pos.order', 'pos.order.line', 'pos.payment']);
            const order = records['pos.order'].find(row => row.uuid === uuid);
            return {state: order?.state, confirmed: order?.alvina_confirmed, lines: records['pos.order.line'].length, payments: records['pos.payment'].length};
        }, orderUuid);
        assert.equal(saved.state, 'paid');
        assert.equal(saved.confirmed, false);
        assert(saved.lines > 0 && saved.payments > 0);
        await page.reload();
        await page.waitForFunction(() => window.posmodel?.models?.['pos.order']);
        const unlock = page.getByText('Unlock Register', {exact: true});
        if (await unlock.isVisible()) { await unlock.click(); }
        await page.waitForFunction(uuid => window.posmodel?.models['pos.order'].getBy('uuid', uuid), orderUuid);
        const restored = await page.evaluate(uuid => {
            const order = window.posmodel.models['pos.order'].getBy('uuid', uuid);
            return {state: order.state, confirmed: order.alvina_confirmed, removable: order.canBeRemovedFromIndexedDB, lines: order.lines.length, payments: order.payment_ids.length};
        }, orderUuid);
        assert(['paid', 'draft'].includes(restored.state));
        if (!dropBeforeCommit) { assert.equal(restored.state, 'paid'); }
        assert(restored.confirmed || !restored.removable, 'Unresolved restored payments must be retained');
        assert(restored.lines > 0 && restored.payments > 0, 'Products and payments must survive reload');
        blocked = false;
        // Keep observing requests while allowing normal recovery traffic.
        await page.evaluate(uuid => {
            window.posmodel.data.network.offline = false;
            window.posmodel.dialog.closeAll();
            const order = window.posmodel.models['pos.order'].getBy('uuid', uuid);
            window.posmodel.navigate(order.alvina_confirmed ? 'ReceiptScreen' : 'PaymentScreen', {orderUuid: uuid});
        }, orderUuid);
        if (!restored.confirmed) { await page.getByText('Validate', {exact: true}).click(); }
        await page.locator('.alvina-receipt-discount').waitFor({timeout: 30000});
        assert.match(await page.locator('.receipt-total').innerText(), /85[.,]00/);
        assert(paidRequests >= (dropBeforeCommit ? 2 : 1));
        const sales = await page.evaluate(async uuid => window.posmodel.data.call(
            'pos.order', 'search_read', [[['uuid', '=', uuid]]],
            {fields: ['id', 'state', 'amount_total', 'payment_ids']}), orderUuid);
        assert.equal(sales.length, 1, 'Network retries must keep the same single order');
        assert.equal(sales[0].payment_ids.length, 1, 'Network retries must not duplicate payment lines');
        assert.equal(sales[0].amount_total, 85);
        const used = await page.evaluate(async ({uuid, dni}) => {
            // A new cart lookup sees exactly one S/ 15 consumption.
            window.posmodel.addNewOrder();
            const order = window.posmodel.getOrder();
            const product = window.posmodel.models['product.product'].getAll().find(p => p.product_tmpl_id.name.includes('ALVIÑA Producto UI'));
            await window.posmodel.addLineToOrder({product_tmpl_id: product.product_tmpl_id}, order);
            await window.posmodel.alvinaSync(order);
            return await window.posmodel.data.call('pos.order', 'alvina_lookup', [order.uuid, dni]);
        }, {uuid: orderUuid, dni: fixture.dni});
        assert.equal(used.used, 15);
        console.log(dropBeforeCommit
            ? 'PASS: interrupted payment before commit survives reload and retries safely; exactly one sale and one S/ 15 consumption.'
            : 'PASS: lost committed payment response survives IndexedDB reload; one sale, one S/ 15 consumption; recovery by server status.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
