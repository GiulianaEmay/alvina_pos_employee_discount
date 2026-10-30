import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import OrderPaymentValidation from "@point_of_sale/app/utils/order_payment_validation";

patch(PosOrder.prototype, {
    alvinaInvalidate() {
        if (!this.alvina_operation || this._alvinaApplying || this.state !== "draft") { return; }
        this._alvinaApplying = true;
        try {
            for (const line of this.lines) { line.discount = 0; }
            this.alvina_amount = 0;
            this._alvinaStale = true;
        } finally { this._alvinaApplying = false; }
    },
    removeOrderline(line) {
        this.alvinaInvalidate();
        return super.removeOrderline(...arguments);
    },
    setPricelist() {
        this.alvinaInvalidate();
        return super.setPricelist(...arguments);
    },
});
patch(PosOrderline.prototype, {
    setQuantity() {
        this.order_id?.alvinaInvalidate();
        return super.setQuantity(...arguments);
    },
    setUnitPrice() {
        // setOptions/setup may normalize the same price; only real edits invalidate.
        if (Number(arguments[0]) !== this.price_unit) { this.order_id?.alvinaInvalidate(); }
        return super.setUnitPrice(...arguments);
    },
    setDiscount() {
        if (this.order_id?.alvina_operation && !this.order_id._alvinaApplying) {
            this.order_id.alvinaInvalidate();
            return; // A cashier cannot replace the server-assigned benefit rate.
        }
        return super.setDiscount(...arguments);
    },
});
patch(PosStore.prototype, {
    async alvinaSync(order) {
        if (this.data.network.offline) { throw new Error("Se requiere conexión con el servidor."); }
        this.addPendingOrder([order.id]);
        const result = await this.syncAllOrders({ orders: [order], force: true, throw: true });
        if (!result?.length) { throw new Error("El pedido aún no se sincronizó. Reintente."); }
    },
    async addLineToOrder(vals, order) {
        order.alvinaInvalidate();
        return await super.addLineToOrder(...arguments);
    },
});
patch(OrderPaymentValidation.prototype, {
    async validateOrder() {
        if (this.order.alvina_operation) {
            try {
                // A failed response can hide a committed payment. Resolve that
                // uncertainty online before editing, charging again or removing.
                if (this.order.state === "paid") {
                    const status = await this.pos.data.call("pos.order", "alvina_status", [this.order.uuid]);
                    if (status.confirmed) {
                        await this.pos.data.read("pos.order", [status.id]);
                        this.pos.navigate("ReceiptScreen", { orderUuid: this.order.uuid });
                        return true;
                    }
                    this.order.state = "draft";
                }
                if (this.order._alvinaStale || !this.order.alvina_amount) {
                    throw new Error("La compra cambió. Vuelva a aplicar o retire el beneficio.");
                }
                await this.pos.alvinaSync(this.order);
                await this.pos.data.call("pos.order", "alvina_validate", [this.order.uuid]);
            } catch (error) {
                this.pos.dialog.add(AlertDialog, {
                    title: "Beneficio pendiente de validación",
                    body: error.data?.message || error.message || "Reconecte antes de finalizar.",
                });
                return false;
            }
        }
        return await super.validateOrder(...arguments);
    },
    async shouldHideValidationBehindFeedbackScreen() {
        if (!this.order.alvina_operation) {
            return await super.shouldHideValidationBehindFeedbackScreen(...arguments);
        }
        this.pos.env.services.ui.block();
        try {
            // Never navigate/print on a ConnectionLostError, even with fast payment.
            await this.finalizeValidation();
            const status = await this.pos.data.call("pos.order", "alvina_status", [this.order.uuid]);
            if (!status.confirmed) { throw new Error("El servidor no confirmó el consumo."); }
            this.pos.navigate("ReceiptScreen", { orderUuid: this.order.uuid });
        } catch (error) {
            this.pos.dialog.add(AlertDialog, {
                title: "Venta sin confirmación",
                body: "No vuelva a cobrar. Reconecte y pulse Validar para consultar el estado. " +
                    (error.data?.message || error.message || ""),
            });
        } finally { this.pos.env.services.ui.unblock(); }
    },
    handleValidationError(error) {
        if (this.order.alvina_operation) { throw error; }
        return super.handleValidationError(...arguments);
    },
});
