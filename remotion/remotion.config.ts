import { Config } from "@remotion/cli/config";

// Screen recordings are text on flat colour, which is exactly what aggressive
// quantisation ruins, so the CRF is tighter than Remotion's default.
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setCodec("h264");
Config.setCrf(17);
Config.setChromiumOpenGlRenderer("angle");
