export function syntheticGlb(change = () => {}) {
  const binary = Buffer.alloc(48);
  [0, 0, 0, 1, 0, 0, 0, 1, 1].forEach((n, i) => binary.writeFloatLE(n, i * 4));
  binary.fill(255, 36, 48);
  const doc = {
    asset: { version: '2.0' }, buffers: [{ byteLength: 48 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }, { bufferView: 1, componentType: 5121, normalized: true, count: 3, type: 'VEC4' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, mode: 4 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  change(doc, binary);
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length + 8 + binary.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const dataHeader = Buffer.alloc(8); dataHeader.writeUInt32LE(binary.length); dataHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, dataHeader, binary]);
}
