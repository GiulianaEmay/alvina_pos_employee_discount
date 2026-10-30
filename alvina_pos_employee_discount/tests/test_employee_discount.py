from datetime import datetime
from decimal import Decimal
from uuid import uuid4
import secrets

from freezegun import freeze_time
from psycopg2 import IntegrityError

from odoo import Command, fields
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests import tagged
from odoo.addons.account.tests.common import AccountTestInvoicingCommon


@tagged('post_install', '-at_install')
class TestEmployeeDiscount(AccountTestInvoicingCommon):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env.user.group_ids |= cls.env.ref('point_of_sale.group_pos_manager') | cls.env.ref('hr.group_hr_user')
        cls.company_data['company'].currency_id = cls.env.ref('base.PEN')
        cls.env.ref('base.PEN').active = True
        cls.dni = str(secrets.randbelow(90000000) + 10000000)
        while cls.env['hr.employee'].sudo().search_count([('alvina_authorized_dni', '=', cls.dni)]):
            cls.dni = str(secrets.randbelow(90000000) + 10000000)
        cls.employee = cls.env['hr.employee'].create({
            'name': 'Colaborador de prueba', 'identification_id': cls.dni,
            'alvina_discount_authorized': True,
        })
        cls.product = cls.env['product.product'].create({
            'name': 'Producto ALVIÑA', 'type': 'consu', 'available_in_pos': True,
            'list_price': 100, 'taxes_id': [Command.clear()],
            'property_account_income_id': cls.company_data['default_account_revenue'].id,
        })
        cls.payment_method = cls.env['pos.payment.method'].create({
            'name': 'Banco prueba', 'journal_id': cls.company_data['default_journal_bank'].id,
        })
        cls.config = cls.env['pos.config'].create({
            'name': 'Sucursal A', 'journal_id': cls.company_data['default_journal_sale'].id,
            'invoice_journal_id': cls.company_data['default_journal_sale'].id,
            'payment_method_ids': [Command.set(cls.payment_method.ids)], 'cash_control': False,
        })
        cls.session = cls.env['pos.session'].create({'config_id': cls.config.id, 'user_id': cls.env.uid})
        cls.session.set_opening_control(0, 'Prueba')
        cls.ledger = cls.env['alvina.employee.discount'].sudo()

    def order(self, total=100, session=None, taxes=None):
        order = self.env['pos.order'].create({
            'session_id': (session or self.session).id, 'uuid': str(uuid4()),
            'amount_total': total, 'amount_tax': 0, 'amount_paid': 0, 'amount_return': 0,
            'lines': [Command.create({
                'product_id': self.product.id, 'qty': 1, 'price_unit': total,
                'price_subtotal': total, 'price_subtotal_incl': total,
                'tax_ids': [Command.set(taxes.ids if taxes else [])],
            })],
        })
        order._compute_prices()
        return order

    def reserve(self, order):
        result = self.env['pos.order'].alvina_reserve(order.uuid, self.dni, True)
        order.write({'alvina_operation': result['operation']})
        order.lines.write({'discount': result['effective_rate']})
        order._compute_prices()
        return result

    def pay(self, order):
        order.add_payment({'pos_order_id': order.id, 'amount': order.amount_total, 'payment_method_id': self.payment_method.id,
                           'payment_date': fields.Datetime.now()})
        order._process_saved_order(False)
        return self.ledger.search([('order_id', '=', order.id)])

    def test_valid_dni(self):
        result = self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)
        self.assertEqual(result['name'], self.employee.name)
        self.assertEqual(result['amount'], 15)

    def test_invalid_and_unknown_dni(self):
        order = self.order()
        for dni in ('87654321', '123', '１２３４５６７８', '', None):
            with self.assertRaises(UserError):
                self.env['pos.order'].alvina_lookup(order.uuid, dni)

    def test_duplicate_dni(self):
        with self.assertRaises(IntegrityError), self.cr.savepoint():
            self.env['hr.employee'].create({'name': 'Duplicado', 'identification_id': self.dni, 'alvina_discount_authorized': True})
            self.env.flush_all()

    def test_invalid_authorized_dni(self):
        with self.assertRaises(ValidationError), self.cr.savepoint():
            self.employee.identification_id = 'bad'
            self.env.flush_all()

    def test_version_dni_change_updates_identity(self):
        self.employee.current_version_id.identification_id = '11112222'
        self.env.flush_all()
        self.assertEqual(self.employee.alvina_authorized_dni, '11112222')

    def test_inactive(self):
        self.employee.active = False
        with self.assertRaises(UserError):
            self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)

    def test_unauthorized(self):
        self.employee.alvina_discount_authorized = False
        with self.assertRaises(UserError):
            self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)

    def test_fifteen_percent_and_standard_payment(self):
        order = self.order(200)
        self.assertEqual(self.reserve(order)['amount'], 30)
        self.assertEqual(order.lines.discount, 15)
        self.assertEqual(order.amount_total, 170)
        entry = self.pay(order)
        self.assertEqual(entry.state, 'consumed')
        self.assertEqual(order.alvina_amount, 30)
        self.assertEqual(order.state, 'paid')

    def test_cap_exact_and_exhaustion(self):
        order = self.order(1000)
        self.assertEqual(self.reserve(order)['amount'], 100)
        self.pay(order)
        with self.assertRaises(UserError):
            self.reserve(self.order())

    def test_multiple_purchases_and_capped_last(self):
        for total, amount in ((200, 30), (400, 60), (200, 10)):
            order = self.order(total)
            self.assertEqual(self.reserve(order)['amount'], amount)
            self.pay(order)
        self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), Decimal('100'))

    def test_reserved_amount_counts_other_cashbox(self):
        self.reserve(self.order(600))
        order = self.order(200)
        self.assertEqual(self.reserve(order)['amount'], 10)

    def test_cross_branch_shared_cap(self):
        other = self.config.copy({'name': 'Sucursal B'})
        session = self.env['pos.session'].create({'config_id': other.id, 'user_id': self.env.uid})
        session.set_opening_control(0, 'Prueba')
        self.reserve(self.order(600))
        result = self.reserve(self.order(200, session=session))
        self.assertEqual(result['amount'], 10)

    def test_monday_lima_boundary(self):
        self.assertEqual(str(self.ledger._week(datetime(2026, 11, 2, 4, 59, 59))), '2026-10-26')
        self.assertEqual(str(self.ledger._week(datetime(2026, 11, 2, 5))), '2026-11-02')

    def test_no_rollover_empty_week(self):
        with freeze_time('2026-10-20 15:00:00'):
            self.assertEqual(self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)['available'], 100)
        with freeze_time('2026-10-27 15:00:00'):
            self.assertEqual(self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)['available'], 100)

    def test_no_rollover_used_week(self):
        with freeze_time('2026-10-20 15:00:00'):
            order = self.order(400)
            self.reserve(order)
            self.pay(order)
        with freeze_time('2026-10-27 15:00:00'):
            self.assertEqual(self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)['available'], 100)

    def test_expired_reservation_releases_budget(self):
        with freeze_time('2026-10-30 15:00:00'):
            old = self.order(600)
            self.reserve(old)
        with freeze_time('2026-10-30 15:11:00'):
            self.assertEqual(self.reserve(self.order(1000))['amount'], 100)
            with self.assertRaises(UserError):
                old._alvina_validate_reservation()

    def test_week_change_requires_new_authorization(self):
        with freeze_time('2026-11-02 04:59:00'):
            order = self.order()
            self.reserve(order)
        with freeze_time('2026-11-02 05:01:00'):
            with self.assertRaises(UserError):
                order._alvina_validate_reservation()

    def test_idempotent_reservation(self):
        order = self.order()
        self.reserve(order)
        self.reserve(order)
        self.assertEqual(self.ledger.search_count([('operation', '=', order.uuid)]), 1)
        self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), Decimal('15'))

    def test_retried_ui_sync_does_not_consume_again(self):
        order = self.order()
        self.reserve(order)
        self.pay(order)
        self.assertTrue(self.env['pos.order'].alvina_status(order.uuid)['confirmed'])
        self.env['pos.order'].sync_from_ui([{
            'uuid': order.uuid, 'session_id': self.session.id, 'lines': [],
        }])
        self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), Decimal('15'))

    def test_release_is_idempotent(self):
        order = self.order(600)
        self.reserve(order)
        self.env['pos.order'].alvina_release(order.uuid)
        self.env['pos.order'].alvina_release(order.uuid)
        self.assertEqual(self.reserve(self.order(1000))['amount'], 100)

    def test_cancel_releases_reservation(self):
        order = self.order(600)
        self.reserve(order)
        order.action_pos_order_cancel()
        self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), 0)

    def test_cart_change_and_discount_tamper_rejected(self):
        for field, value in (('qty', 2), ('price_unit', 50), ('discount', 30)):
            order = self.order()
            self.reserve(order)
            order.lines.write({field: value})
            with self.assertRaises(UserError):
                order._alvina_validate_reservation()

    def test_promotions_rejected(self):
        order = self.order()
        order.lines.discount = 5
        with self.assertRaises(UserError):
            self.reserve(order)

    def test_requires_physical_verification(self):
        with self.assertRaises(UserError):
            self.env['pos.order'].alvina_reserve(self.order().uuid, self.dni, False)

    def test_forged_operation_rejected(self):
        order = self.order()
        order.alvina_operation = 'forged'
        with self.assertRaises(UserError):
            order._alvina_validate_reservation()

    def test_taxes_included_and_excluded(self):
        for included in (True, False):
            tax = self.env['account.tax'].create({
                'name': 'IGV 18%% incluido %s' % included, 'amount': 18, 'amount_type': 'percent',
                'price_include_override': 'tax_included' if included else 'tax_excluded',
            })
            order = self.order(100, taxes=tax)
            original = 100 if included else 118
            expected = 15 if included else 17.70
            result = self.reserve(order)
            self.assertEqual(result['original'], original)
            self.assertEqual(result['amount'], expected)
            self.assertAlmostEqual(order.amount_total, original - expected, places=2)
            self.pay(order)

    def test_standard_invoice_keeps_discount_and_balanced_move(self):
        order = self.order(200)
        order.partner_id = self.partner_a
        self.reserve(order)
        self.pay(order)
        order._generate_pos_order_invoice()
        invoice = order.account_move
        self.assertEqual(invoice.state, 'posted')
        self.assertEqual(invoice.amount_total, 170)
        self.assertAlmostEqual(sum(invoice.line_ids.mapped('balance')), 0, places=2)
        self.assertEqual(invoice.invoice_line_ids.discount, 15)
        self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), Decimal('30'))

    def test_cashier_has_no_ledger_or_hr_access(self):
        cashier = self.env['res.users'].create({
            'name': 'Cajero', 'login': 'alvina_test_cashier',
            'group_ids': [Command.set([self.env.ref('point_of_sale.group_pos_user').id])],
            'company_id': self.env.company.id, 'company_ids': [Command.set(self.env.company.ids)],
        })
        with self.assertRaises(AccessError):
            self.ledger.with_user(cashier).search([])
        with self.assertRaises(AccessError):
            self.employee.with_user(cashier).read(['identification_id'])
        with self.assertRaises(AccessError):
            self.env['pos.order'].with_user(cashier).alvina_lookup(self.order().uuid, self.dni)

    def test_original_week_refund_no_current_credit(self):
        with freeze_time('2026-10-20 15:00:00'):
            order = self.order(200)
            self.reserve(order)
            entry = self.pay(order)
        with freeze_time('2026-10-27 15:00:00'):
            refund = self.order(-200)
            refund.lines.write({'qty': -1, 'price_unit': 200, 'discount': 15,
                                'refunded_orderline_id': order.lines.id})
            refund._compute_prices()
            self.pay(refund)
            self.assertEqual(entry.reversed_amount, 30)
            refund._alvina_reverse_refunds()
            self.assertEqual(entry.reversed_amount, 30)
            self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), 0)
            self.assertEqual(self.env['pos.order'].alvina_lookup(self.order().uuid, self.dni)['available'], 100)

    def test_reapply_after_cart_change(self):
        order = self.order()
        self.reserve(order)
        order.lines.write({'qty': 2, 'discount': 0})
        self.assertEqual(self.reserve(order)['amount'], 30)
        self.pay(order)

    def test_revoke_after_reservation(self):
        order = self.order()
        self.reserve(order)
        self.employee.alvina_discount_authorized = False
        with self.assertRaises(UserError):
            order._alvina_validate_reservation()

    def test_paid_sale_cannot_be_edited(self):
        order = self.order()
        self.reserve(order)
        self.pay(order)
        with self.assertRaises(UserError):
            order.lines.write({'discount': 90})
        with self.assertRaises(UserError):
            order.write({'alvina_operation': False})

    def test_fixed_tax_gross_cap(self):
        tax = self.env['account.tax'].create({'name': 'Impuesto fijo', 'amount_type': 'fixed', 'amount': 2})
        order = self.order(100, taxes=tax)
        self.assertEqual(self.reserve(order)['amount'], 15.30)
        self.assertAlmostEqual(order.amount_total, 86.70, places=2)

    def test_cannot_skip_paid_transition(self):
        order = self.order()
        self.reserve(order)
        with self.assertRaises(UserError):
            order.write({'state': 'done'})

    def test_cancelled_benefit_cannot_keep_discount(self):
        order = self.order()
        self.reserve(order)
        self.env['pos.order'].alvina_release(order.uuid)
        order.alvina_operation = False
        with self.assertRaises(UserError):
            order._alvina_validate_reservation()

    def test_partial_refund_restores_only_original_fraction(self):
        order = self.order(200)
        order.lines.qty = 2
        self.reserve(order)
        entry = self.pay(order)
        refund = self.order(-200)
        refund.lines.write({'qty': -1, 'price_unit': 200, 'discount': 15,
                            'refunded_orderline_id': order.lines.id})
        refund._compute_prices()
        self.pay(refund)
        self.assertEqual(entry.reversed_amount, 30)
        self.assertEqual(self.ledger._usage(self.employee, self.ledger._week()), Decimal('30'))
