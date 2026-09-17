/**
 * The documentation's figures, drawn on the server in the dashboard's own
 * style — the boxes, arrows and labels of diagrams.ts, the same palette, no
 * image files. A chapter embeds one as `![caption](diagram:<name>)`; the
 * name is a key of DOC_DIAGRAMS and the caption becomes the figure's.
 */
import { dbox, darrow, dline, dpath, dlab, svgo } from "./diagrams";

function stub(name: string): string {
  return svgo(800, 80, name) + dbox({ x: 20, y: 20, w: 200, h: 40, title: name }) + darrow(220, 40, 300, 40) + dline([300, 40, 320, 40]) + dpath("M320 40 L340 40") + dlab(400, 44, ["placeholder"]) + "</svg>";
}

export const DOC_DIAGRAMS: Record<string, () => string> = {
  "publishing-layer": () => stub("publishing-layer"),
  "release-promotion": () => stub("release-promotion"),
  "promotion-gates": () => stub("promotion-gates"),
  "release-pipeline": () => stub("release-pipeline"),
  "thin-client-install": () => stub("thin-client-install"),
  "benchmark-promotion": () => stub("benchmark-promotion"),
  "transaction-lifecycle": () => stub("transaction-lifecycle"),
  "factory-loop": () => stub("factory-loop"),
};
