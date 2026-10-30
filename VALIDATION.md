# Validación de la entrega

Ejecución local del 30 de octubre de 2026. Addon creado desde un repositorio sin commits.

## Entorno verificado

- Odoo Community 19.0 oficial, commit `ee10b64ad86329766d31d2c2800fbe9ec36c2e46`.
- Python 3.12.14, PostgreSQL 17.11 y Node.js 24.19.0.
- 67 módulos estándar instalados; dependencias directas del addon: `point_of_sale`, `hr`.
- El runtime de desarrollo usa el wheel `psycopg2-binary==2.9.9` y omite el
  conector de autenticación LDAP opcional. El addon no añade paquetes Python ni npm.
- PostgreSQL por socket local; Odoo HTTP limitado a loopback. Sin credenciales
  reales de ALVIÑA ni acceso a una instancia de producción.

## Resultados

| Verificación | Resultado final |
| --- | --- |
| Instalación y actualización reales del addon | Correctas; modelos, ACL y vistas XML cargados |
| Suite backend Odoo | **36 ejecutadas, 0 fallos, 0 errores** |
| Pruebas unitarias JS de los parches de producción | **8 ejecutadas, 8 aprobadas** |
| Dos reservas en conexiones PostgreSQL concurrentes | **S/ 90 + S/ 10 = S/ 100**, con un reintento por serialización; fixtures limpiadas |
| Chromium con assets y componentes OWL reales | Consulta DNI, reserva, pago y ticket aprobados; sin errores de runtime |
| Ticket de la venta de navegador | Original S/ 100, descuento S/ 15, total S/ 85; sin DNI completo |
| Facturación estándar posterior al pago | Factura publicada, importe correcto y asientos balanceados; sin doble consumo |
| Impuestos incluidos, excluidos y fijos | Aprobados en backend usando el motor fiscal de Odoo |
| Python, XML, manifiesto, rutas de assets e icono PNG | Aprobados |
| Script de actualización del entorno | Ejecutado correctamente; instrucciones guardadas en el borrador |
| Disponibilidad local | PostgreSQL acepta conexiones y Odoo responde HTTP 200 |

La suite backend incluye DNI válido/inexistente/duplicado/inválido, versión HR,
empleado inactivo/no autorizado, verificación presencial, agotamiento exacto,
compras múltiples, cupo compartido entre sucursales, reservas y expiración,
reintentos de sincronización, lunes de Lima, semanas sin consumo ni arrastre,
cancelaciones, devoluciones completas/parciales y de semanas anteriores,
manipulación de líneas/estados, reaplicación, impuestos y contabilidad.

Las ocho pruebas JS comprueban que el flujo no llega al cobro sin conexión o con
rechazo del servidor, evita el fallback offline, invalida cambios del carrito,
impide reemplazar manualmente el porcentaje, exige confirmación del servidor y
consulta una respuesta de pago incierta antes de un segundo intento.

Los scripts reproducibles están en `tools/`. Los logs de ejecución de esta máquina
están fuera del repositorio: `/workspace/alvina-final-tests-3.log`,
`/workspace/alvina-concurrency-final-2.log`, `/workspace/alvina-http-final.log` y
`/workspace/alvina-install-final.log`. No se incluyen accesos temporales en Git.

## Límites de esta validación

- No probado en producción ni certificado para SUNAT.
- Pendientes Enterprise, emisión electrónica peruana, hardware fiscal/terminales
  reales e integración con módulos particulares de facturación asíncrona.
- Promociones: se rechazan descuentos previos, recompensas detectables, reglas de
  listas de precios, precios manuales y combos. Rebajas incorporadas al catálogo
  requieren control administrativo; no existe una marca estándar universal.
- Las pruebas JS unitarias usan fronteras de red controladas. Se complementaron
  con una venta real en Chromium, no con una simulación del POS completo.
- La configuración del entorno se guardó como borrador (`install_script` y
  `start_skill`). Su publicación y restauración en una tarea nueva no se realizaron.
- Se crea un commit local por solicitud del usuario. No se hace push automático.

## Árbol final

```text
/
├── alvina_pos_employee_discount/
│   ├── data/
│   │   └── defaults.xml
│   ├── models/
│   │   ├── __init__.py
│   │   ├── employee_discount.py
│   │   ├── hr_employee.py
│   │   ├── pos_config.py
│   │   ├── pos_order.py
│   │   └── res_config_settings.py
│   ├── security/
│   │   ├── ir.model.access.csv
│   │   └── security.xml
│   ├── static/
│   │   ├── description/
│   │   │   └── icon.png
│   │   └── src/
│   │       └── app/
│   │           ├── employee_discount.scss
│   │           ├── employee_discount_button.js
│   │           ├── employee_discount_button.xml
│   │           ├── employee_discount_popup.js
│   │           ├── employee_discount_popup.xml
│   │           ├── employee_discount_receipt.xml
│   │           └── employee_discount_validation.js
│   ├── tests/
│   │   ├── __init__.py
│   │   └── test_employee_discount.py
│   ├── views/
│   │   ├── employee_discount_views.xml
│   │   ├── hr_employee_views.xml
│   │   └── res_config_settings_views.xml
│   ├── README.md
│   ├── __init__.py
│   └── __manifest__.py
├── tools/
│   ├── browser_smoke.cjs
│   ├── prepare_browser_fixture.py
│   ├── run_odoo_tests.sh
│   ├── test_concurrency.py
│   ├── test_frontend.mjs
│   └── validate_static.py
├── .gitignore
├── LICENSE
├── README.md
└── VALIDATION.md
```
