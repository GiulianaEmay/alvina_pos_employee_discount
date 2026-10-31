# Validación funcional y visual

Revisión local del 30 de octubre de 2026, sobre la entrega inicial del addon.

## Acceso desde Acciones — 19.0.1.1.2

Ajuste del 31 de octubre de 2026: **Descuento colaborador** aparece únicamente en
**tres puntos → Acciones**, con icono de identificación y las clases nativas de
las demás tarjetas. Se retiró de la barra principal y se quitó el estilo compacto
anterior. Acciones se cierra al abrir la ventana del beneficio.

Comprobado en Chromium: tarjeta de 310 × 124.25 px, idéntica a las tarjetas nativas
en la misma ventana; sin desbordamiento. El flujo desde Acciones hasta el pago y
el ticket también pasó: S/ 100 − S/ 15 = S/ 85.

## Ajuste visual anterior — 19.0.1.1.1

El botón se renombró a **Dscto. Colaborador**, con fuente de 14 px y texto en una
sola línea. En Chromium a 1366 × 600 se comprobó un tamaño de 141 × 49 px,
alineado con la altura de 49 px del control nativo, sin recorte ni desbordamiento.
La venta real mediante el botón renombrado también pasó: S/ 100 − S/ 15 = S/ 85.
Las pruebas funcionales detalladas abajo corresponden a la revisión 19.0.1.1.0;
el ajuste visual conserva esa lógica.

## Entorno verificado

- Odoo Community 19.0 oficial, commit `ee10b64ad86329766d31d2c2800fbe9ec36c2e46`.
- Python 3.12.14, PostgreSQL 17.11 y Node.js 24.19.0.
- 67 módulos estándar instalados; dependencias directas del addon: `point_of_sale`, `hr`.
- El runtime de desarrollo usa el wheel `psycopg2-binary==2.9.9` y omite el
  conector de autenticación LDAP opcional. El addon no añade paquetes Python ni npm.
- PostgreSQL por socket local; Odoo HTTP limitado a loopback. Sin credenciales
  reales de ALVIÑA ni acceso a una instancia de producción.

## Correcciones de operación continua

- Los pagos cuya respuesta se pierde se guardan inmediatamente en IndexedDB. El
  ID numérico del borrador ya no se toma como prueba de pago confirmado.
- La confirmación la establece exclusivamente el servidor; se migran los consumos
  anteriores. La recuperación consulta el estado antes de volver a cobrar y bloquea
  cambios de productos/pagos mientras el resultado siga incierto.
- Las devoluciones nuevas que el POS envía directamente como pagadas ahora reponen
  el consumo original. Se valida su contexto fiscal y se protege lo ya revertido.
- Se permite cambiar de colaborador tras retirar el beneficio, conservando historial,
  y renovar una reserva vencida en línea. Sincronizaciones simultáneas se serializan.
- Se evita la discrepancia entre POS y factura por porcentajes de cupo parcial que
  superan la precisión contable. Se prueban factura y nota de crédito con IGV y
  cantidades múltiples; no se modifica la precisión global de Odoo.
- Leer auditoría no bloquea cajas ni escribe estados. Cupos con fracciones de céntimo
  o valores no finitos/corruptos se rechazan. También se bloquean modificaciones
  fiscales posteriores y adición de líneas mediante valores por defecto de RPC.

## Resultados

| Verificación | Resultado final |
| --- | --- |
| Instalación y actualización reales del addon | Correctas; modelos, ACL y vistas XML cargados |
| Suite backend Odoo | **51 ejecutadas, 0 fallos, 0 errores** |
| Pruebas unitarias JS de los parches de producción | **16 ejecutadas, 16 aprobadas** |
| Dos reservas en conexiones PostgreSQL concurrentes | **S/ 90 + S/ 10 = S/ 100**, con un reintento por serialización; fixtures limpiadas |
| Chromium con assets y componentes OWL reales | Consulta DNI, reserva, pago y ticket aprobados; sin errores de runtime |
| Desconexión antes y después del commit, con recarga | Ambos escenarios aprobados; un pedido, una línea de pago y un consumo |
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
manipulación de líneas/estados, reaplicación, impuestos, cierre de caja, migración y contabilidad.

Las dieciséis pruebas JS comprueban que el flujo no llega al cobro sin conexión o con
rechazo del servidor, evita el fallback offline, invalida cambios del carrito,
impide reemplazar manualmente el porcentaje, exige confirmación del servidor y
consulta una respuesta de pago incierta antes de un segundo intento. Se valida
retención en IndexedDB, ruta de recuperación y coordinación con sincronización
en segundo plano usando el Mutex real de Odoo.

Los scripts reproducibles están en `tools/`. Los logs de ejecución de esta máquina
están fuera del repositorio: `/workspace/alvina-review-final-tests-5.log`,
`/workspace/alvina-review-concurrency.log` y `/workspace/alvina-review-browser-suite-final.log`. No se incluyen accesos temporales en Git.

## Límites de esta validación

- No probado en producción ni certificado para SUNAT.
- Pendientes Enterprise, emisión electrónica peruana, hardware fiscal/terminales
  reales e integración con módulos particulares de facturación asíncrona.
- Promociones: se rechazan descuentos previos, recompensas detectables, reglas de
  listas de precios, precios manuales y combos. Rebajas incorporadas al catálogo
  requieren control administrativo; no existe una marca estándar universal.
- Las pruebas JS unitarias usan fronteras de red controladas. Se complementaron
  con tres escenarios reales en Chromium, incluidos fallos de red y recarga.
- La configuración del entorno se guardó como borrador (`install_script` y
  `start_skill`). Su publicación y restauración en una tarea nueva no se realizaron.
- Se crea un commit local por solicitud del usuario. No se hace push automático.

## Árbol final

```text
/
├── alvina_pos_employee_discount/
│   ├── data/
│   │   └── defaults.xml
│   ├── migrations/
│   │   └── 19.0.1.1.0/
│   │       └── post-migrate.py
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
│   │   │   ├── icon.png
│   │   │   └── index.html
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
│   ├── browser_recovery.cjs
│   ├── browser_smoke.cjs
│   ├── prepare_browser_fixture.py
│   ├── run_browser_tests.sh
│   ├── run_odoo_tests.sh
│   ├── test_concurrency.py
│   ├── test_frontend.mjs
│   └── validate_static.py
├── .gitignore
├── LICENSE
├── README.md
└── VALIDATION.md
```
