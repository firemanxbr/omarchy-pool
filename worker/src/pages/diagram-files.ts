/** The diagrams the markdown chapters embed, served at /docs/diagrams/<name>.svg. */
import benchmarkPromotion from "../docs/diagrams/benchmark-promotion.svg";
import promotionGates from "../docs/diagrams/promotion-gates.svg";
import publishingLayer from "../docs/diagrams/publishing-layer.svg";
import releasePipeline from "../docs/diagrams/release-pipeline.svg";
import releasePromotion from "../docs/diagrams/release-promotion.svg";
import thinClientInstall from "../docs/diagrams/thin-client-install.svg";
import transactionLifecycle from "../docs/diagrams/transaction-lifecycle.svg";

export const DIAGRAMS: Record<string, string> = {
  "benchmark-promotion": benchmarkPromotion,
  "promotion-gates": promotionGates,
  "publishing-layer": publishingLayer,
  "release-pipeline": releasePipeline,
  "release-promotion": releasePromotion,
  "thin-client-install": thinClientInstall,
  "transaction-lifecycle": transactionLifecycle,
};
