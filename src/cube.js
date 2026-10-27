// AR.js marker size is 1. The printable face including white border is 1.25.
export const CUBE_SIZE = 1.25;

export const FACES = [
  { id: "letterA", rot: [-Math.PI / 2, 0, 0], normal: [0, 0, 1], materialIndex: 4, label: "A · 앞", side: "front" },
  { id: "letterB", rot: [0, -Math.PI / 2, Math.PI / 2], normal: [1, 0, 0], materialIndex: 0, label: "B · 오른쪽", side: "right" },
  { id: "letterC", rot: [Math.PI / 2, 0, Math.PI], normal: [0, 0, -1], materialIndex: 5, label: "C · 뒤", side: "back" },
  { id: "letterD", rot: [-Math.PI / 2, Math.PI / 2, 0], normal: [-1, 0, 0], materialIndex: 1, label: "D · 왼쪽", side: "left" },
  { id: "letterF", rot: [Math.PI, 0, 0], normal: [0, -1, 0], materialIndex: 3, label: "F · 아래", side: "bottom" },
  { id: "kanji", rot: [0, 0, 0], normal: [0, 1, 0], materialIndex: 2, label: "人 · 위", side: "top" },
];

export const DEFAULT_TRANSFORM = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
};

export function cloneTransform(transform = DEFAULT_TRANSFORM) {
  return {
    position: [...(transform.position || DEFAULT_TRANSFORM.position)],
    rotation: [...(transform.rotation || DEFAULT_TRANSFORM.rotation)],
    scale: transform.scale ?? 1,
  };
}

export function emptyFaceMeta() {
  return {
    name: "",
    transform: cloneTransform(),
    hasModel: false,
  };
}
