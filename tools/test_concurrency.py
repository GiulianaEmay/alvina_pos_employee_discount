"""Run via odoo-bin shell on a disposable *_test database ONLY.

Uses committed fixtures, independent PostgreSQL connections and real competing
alvina_reserve calls. The database must be disposable; never use a live database.
"""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
import secrets

from psycopg2.errors import SerializationFailure
from odoo import api, Command, sql_db

assert env.cr.dbname.endswith('_test'), 'Use a disposable database ending in _test'
uid, dbname = env.uid, env.cr.dbname
company = env.company
assert not env['account.move'].search_count([('state', '=', 'posted')]), 'Database must have no posted moves'
company.currency_id = env.ref('base.PEN')
env.ref('base.PEN').active = True
env.user.group_ids |= env.ref('point_of_sale.group_pos_manager') | env.ref('hr.group_hr_user')
sale = env['account.journal'].search([('type', '=', 'sale'), ('company_id', '=', company.id)], limit=1)
bank = env['account.journal'].search([('type', '=', 'bank'), ('company_id', '=', company.id)], limit=1)
income = env['account.account'].search([('account_type', '=', 'income'), ('company_ids', 'in', company.ids)], limit=1)
assert sale and bank and income, 'Install the standard generic chart first'
dni = str(secrets.randbelow(90000000) + 10000000)
employee = env['hr.employee'].create({'name': 'TEST CONCURRENCIA', 'identification_id': dni,
                                       'alvina_discount_authorized': True})
product = env['product.product'].create({'name': 'TEST CONCURRENCIA', 'available_in_pos': True,
    'list_price': 600, 'taxes_id': [Command.clear()], 'property_account_income_id': income.id})
pm = env['pos.payment.method'].create({'name': 'TEST CONCURRENCIA', 'journal_id': bank.id})
configs, sessions, orders = [], [], []
for index in range(2):
    config = env['pos.config'].create({'name': 'TEST CAJA %s' % index, 'journal_id': sale.id,
        'invoice_journal_id': sale.id, 'payment_method_ids': [Command.set(pm.ids)], 'cash_control': False})
    session = env['pos.session'].create({'config_id': config.id, 'user_id': uid})
    session.set_opening_control(0, 'Test concurrencia')
    order = env['pos.order'].create({'session_id': session.id, 'uuid': str(uuid4()),
        'amount_tax': 0, 'amount_total': 600, 'amount_paid': 0, 'amount_return': 0,
        'lines': [Command.create({'product_id': product.id, 'qty': 1, 'price_unit': 600,
            'price_subtotal': 600, 'price_subtotal_incl': 600, 'tax_ids': [Command.clear()]})]})
    configs.append(config.id); sessions.append(session.id); orders.append((order.id, order.uuid))
ids = employee.id, product.id, pm.id
context = {'allowed_company_ids': company.ids}
env.cr.commit()
barrier = Barrier(2)

def reserve(uuid):
    barrier.wait(timeout=10)
    for attempt in range(5):
        with sql_db.db_connect(dbname).cursor() as cr:
            local = api.Environment(cr, uid, context)
            try:
                result = local['pos.order'].alvina_reserve(uuid, dni, True)
                cr.commit()
                return result['amount'], attempt
            except SerializationFailure:
                cr.rollback()
    raise AssertionError('Too many serialization conflicts')

try:
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, [uuid for _, uuid in orders]))
    amounts = sorted(amount for amount, _ in results)
    assert amounts == [10.0, 90.0], results
    env.invalidate_all()
    entries = env['alvina.employee.discount'].sudo().search([('employee_id', '=', ids[0])])
    assert sum(entries.mapped('amount')) == 100, entries.mapped('amount')
    result_description = results
finally:
    env.invalidate_all()
    env['alvina.employee.discount'].sudo().search([('employee_id', '=', ids[0])]).unlink()
    env['pos.order'].browse([order_id for order_id, _ in orders]).unlink()
    env['pos.session'].browse(sessions).unlink()
    env['pos.config'].browse(configs).unlink()
    env['pos.payment.method'].browse(ids[2]).unlink()
    env['product.product'].browse(ids[1]).available_in_pos = False
    env['product.product'].browse(ids[1]).unlink()
    env['hr.employee'].browse(ids[0]).unlink()
    env.cr.commit()

print('PASS: two concurrent real POS reservations = S/ 90 + S/ 10; total S/ 100; fixtures cleaned.', result_description)
