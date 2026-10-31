// Development dependencies only: Playwright and a Chromium executable.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
    const fixture = JSON.parse(fs.readFileSync(
        process.env.ALVINA_BROWSER_FIXTURE || '/tmp/alvina-browser-fixture.json', 'utf8'));
    assert(fixture.database.endsWith('_test'), 'Use a disposable test database');
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox'],
    });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const auth = await context.request.post('http://127.0.0.1:8079/web/session/authenticate', {
            data: { jsonrpc: '2.0', method: 'call', params: {
                db: fixture.database, login: fixture.login, password: fixture.password,
            } },
        });
        assert((await auth.json()).result?.uid, 'Local test authentication failed');
        await page.goto(`http://127.0.0.1:8079/pos/ui/${fixture.config}?debug=assets`);
        await page.getByText('Unlock Register', { exact: true }).click({ timeout: 30000 });
        await page.getByText(fixture.product_name, { exact: true }).first().click();
        assert.equal(await page.locator('.alvina-benefit-button').count(), 0, 'Benefit belongs only in Actions');
        await page.locator('.more-btn').click();
        await page.getByRole('button', {name: 'Descuento colaborador', exact: true}).click();
        await page.locator('.control-buttons-modal').waitFor({state: 'hidden'});
        await page.locator('#alvina-dni').fill(fixture.dni);
        await page.getByRole('button', { name: 'Consultar', exact: true }).click();
        await page.locator('.modal dd').last().waitFor();
        assert.match(await page.locator('.modal dd').last().innerText(), /15[.,]00/);
        await page.locator('.modal input[type=checkbox]').check();
        await page.getByRole('button', { name: 'APLICAR DESCUENTO', exact: true }).click();
        await page.locator('.modal').waitFor({ state: 'hidden' });
        await page.getByText('Payment', { exact: true }).click();
        await page.getByText('Validate', { exact: true }).click();
        await page.locator('.alvina-receipt-discount').waitFor({ timeout: 30000 });
        const receipt = await page.locator('.pos-receipt').innerText();
        assert.match(receipt, /Total original/);
        assert.match(receipt, /Descuento Colaborador/);
        assert.match(receipt, /15[.,]00/);
        assert.match(await page.locator('.receipt-total').innerText(), /85[.,]00/);
        assert(!receipt.includes(fixture.dni), 'A receipt must never expose a full DNI');
        assert.deepEqual(errors, [], 'OWL/runtime errors');
        console.log('PASS: real POS identification, reserve, payment and receipt: S/ 100 - S/ 15 = S/ 85');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
