"""Run with odoo-bin shell on a disposable *_test database.
Creates local test records and a random temporary browser login; never use in production.
ALVINA_BROWSER_FIXTURE selects the private JSON file read by browser_smoke.cjs.
"""
from odoo import Command
import json, os, secrets
from uuid import uuid4
assert env.cr.dbname.endswith('_test'), 'Use a disposable *_test database only'
fixture_path = os.environ.get('ALVINA_BROWSER_FIXTURE', '/tmp/alvina-browser-fixture.json')
fixture_dni = str(secrets.randbelow(90000000) + 10000000)
fixture_product_name = 'ALVIÑA Producto UI ' + uuid4().hex[:8]
admin = env.ref('base.user_admin')
admin.group_ids |= env.ref('point_of_sale.group_pos_manager') | env.ref('hr.group_hr_user') | env.ref('alvina_pos_employee_discount.group_discount_manager')
password = secrets.token_urlsafe(24)
admin.password = password
company = env.company
company.currency_id = env.ref('base.PEN')
sale = env['account.journal'].search([('type','=','sale'), ('company_id','=',company.id)],limit=1)
bank = env['account.journal'].search([('type','=','bank'), ('company_id','=',company.id)],limit=1)
income = env['account.account'].search([('account_type','=','income'), ('company_ids','in',company.ids)],limit=1)
pm = env['pos.payment.method'].create({'name':'Banco UI', 'journal_id':bank.id})
config = env['pos.config'].create({'name':'ALVIÑA prueba UI', 'journal_id':sale.id, 'invoice_journal_id':sale.id, 'payment_method_ids':[Command.set(pm.ids)], 'cash_control':False})
session = env['pos.session'].create({'config_id':config.id, 'user_id':admin.id})
session.with_user(admin).set_opening_control(0,'Prueba UI local')
product = env['product.product'].create({'name':fixture_product_name, 'available_in_pos':True, 'list_price':100, 'taxes_id':[Command.clear()], 'property_account_income_id':income.id})
employee = env['hr.employee'].create({'name':'Colaborador Prueba UI', 'identification_id':fixture_dni, 'alvina_discount_authorized':True})
with open(fixture_path,'w') as f:
 os.chmod(f.name,0o600)
 json.dump({'login':admin.login,'password':password,'config':config.id,'product':product.id,'product_name':fixture_product_name,'dni':fixture_dni,'database':env.cr.dbname},f)
env.cr.commit()
print('UI fixture prepared')
