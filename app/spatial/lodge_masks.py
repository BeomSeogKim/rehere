"""Offline derivation for the SAM 3.1 lodge index. No network.

    python3 -I lodge_masks.py <capture-summary.json> <recordings.json> <photos.json> <out.json>

Reads the private capture summary and the private recordings (raw provider output, never in Git), decodes every mask with
the pinned official meta-sam-parser (decode_mask_to_raster / decode_mask_to_rle) and writes ONLY derived facts: per request
the response id, request digest, usage and, per returned instance, the box, the model's confidence, the mask area and the
box-local COCO run-length encoding. The base85 payload and the raw output text are never written.
"""
import json
import re
import sys
from pathlib import Path

import meta_sam_parser as m

INT = r'(0|[1-9][0-9]{0,6})'
DEC = r'([01](?:\.[0-9]{1,20})?)'
RECORD = re.compile(
    rf'^{INT}<\|box;x1={INT};y1={INT};x2={INT};y2={INT};w={INT};h={INT}(?:;c={DEC})?\|>'
    rf'<\|mask;x=0;y=0(?:;c={DEC})?;data={INT},{INT},([~!])([!-{{}}~]*)\|>$')
SPLIT = re.compile(r',(?=(?:0|[1-9][0-9]{0,6})<\|box;)')


def instances(output_text, width, height):
    text = output_text.strip()
    if text == '':
        return []
    assert text.startswith('<0f>') and '\n' not in text, 'not one image line'
    out = []
    for part in SPLIT.split(text[4:]):
        found = RECORD.match(part)
        assert found, 'malformed record'
        ident, x1, y1, x2, y2, w, h, box_c, mask_c, mh, mw, marker, rest = found.groups()
        x1, y1, x2, y2, w, h, mh, mw = (int(v) for v in (x1, y1, x2, y2, w, h, mh, mw))
        assert (w, h) == (width, height), 'frame mismatch'
        assert mw == x2 - x1 + 1 and mh == y2 - y1 + 1, 'mask raster does not match its box'
        assert box_c == mask_c, 'confidence mismatch'
        mask = m.SegmentationMask(encoding='lossless' if marker == '~' else 'one_bit', payload=marker + rest, width=mw, height=mh)
        raster = m.decode_mask_to_raster(mask)
        rle = m.decode_mask_to_rle(mask)
        out.append({
            'id': int(ident),
            'box': [x1, y1, x2 + 1, y2 + 1],
            'confidence': None if box_c is None else float(box_c),
            'areaPx': sum(1 for value in raster if value),
            'rle': {'size': [rle.size[0], rle.size[1]], 'counts': rle.counts},
        })
    return out


def main(summary_file, recordings_file, photos_file, out_file):
    summary = json.loads(Path(summary_file).read_text())
    recordings = {item['requestDigest']: item for item in json.loads(Path(recordings_file).read_text())}
    photos = {p['hbs']: p for p in json.loads(Path(photos_file).read_text())['photos']}
    results = []
    for item in summary['results']:
        assert item['status'] == 'returned' and item['imagesProcessed'] == 1, 'only clean results are derived'
        recording = recordings[item['requestDigest']]
        assert recording['responseId'] == item['responseId'], 'recording and summary disagree'
        photo = photos[item['photo']]
        found = instances(recording['outputText'], photo['width'], photo['height'])
        assert [i['id'] for i in found] == [i['id'] for i in item['instances']], 'derived instances differ from the capture summary'
        results.append({
            'photo': item['photo'], 'noun': item['noun'], 'responseId': item['responseId'], 'requestDigest': item['requestDigest'],
            'requestId': item.get('requestId'), 'imagesProcessed': item['imagesProcessed'], 'latencyMs': item['latencyMs'],
            'recordedAt': item['recordedAt'], 'instances': found,
        })
    Path(out_file).write_text(json.dumps({'parser': 'meta-sam-parser==0.1.0', 'results': results}, indent=1))
    print(f'{len(results)} results, {sum(len(r["instances"]) for r in results)} instances')


if __name__ == '__main__':
    main(*sys.argv[1:5])
