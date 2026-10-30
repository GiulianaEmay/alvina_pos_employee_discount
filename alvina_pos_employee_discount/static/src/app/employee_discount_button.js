import { patch } from "@web/core/utils/patch";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { EmployeeDiscountPopup } from "./employee_discount_popup";

patch(ControlButtons.prototype, {
    alvinaDiscount() {
        this.dialog.add(EmployeeDiscountPopup, { pos: this.pos, order: this.pos.getOrder() });
    },
});
