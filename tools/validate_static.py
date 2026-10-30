#!/usr/bin/env python3
"""Validate addon resources without requiring an Odoo database."""
import ast
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
addon = root / 'alvina_pos_employee_discount'
manifest = ast.literal_eval((addon / '__manifest__.py').read_text())
assert manifest['version'].startswith('19.0.')
assert manifest['depends'] == ['point_of_sale', 'hr']
for resource in manifest['data']:
    assert (addon / resource).is_file(), resource
for pattern in manifest['assets']['point_of_sale._assets_pos']:
    assert list(root.glob(pattern)), pattern
for path in addon.rglob('*.py'):
    ast.parse(path.read_text(), filename=str(path))
for path in addon.rglob('*.xml'):
    ET.parse(path)
image = (addon / 'static/description/icon.png').read_bytes()
assert image[:8] == b'\x89PNG\r\n\x1a\n'
assert struct.unpack('>II', image[16:24]) == (256, 256)
for path in addon.rglob('*'):
    if path.is_file() and '__pycache__' not in str(path):
        assert path.stat().st_size, path
print('PASS: Python, XML, manifest resources, POS asset paths, nonempty files and PNG icon')
