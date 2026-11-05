// A plain-object scene for buildManifest: nodes are { name?, extras?, children? }.

/** The tree adapter buildManifest reads (roots / children / name / extras / parent). */
export const tree = (roots) => {
  const parent = new Map();
  const walk = (n) =>
    (n.children || []).forEach((c) => {
      parent.set(c, n);
      walk(c);
    });
  roots.forEach(walk);
  return {
    roots: () => roots,
    children: (n) => n.children || [],
    name: (n) => n.name || "",
    extras: (n) => n.extras || {},
    parent: (n) => parent.get(n) || null,
  };
};

/** Node extras carrying an fp tag. */
export const fp = (o) => ({ fp: o });
