// Builds the ordered API route table from the route modules.
const createSystemRoutes = require("./system.cjs");
const createLlmRoutes = require("./llm.cjs");
const createSpeechRoutes = require("./speech.cjs");
const createTtsRoutes = require("./tts.cjs");
const createSearchRoutes = require("./search.cjs");
const createModelsRoutes = require("./models.cjs");
const createImageRoutes = require("./image.cjs");
const createOutputsRoutes = require("./outputs.cjs");

module.exports = function createRoutes(ctx) {
  return [
    ...createSystemRoutes(ctx),
    ...createLlmRoutes(ctx),
    ...createSpeechRoutes(ctx),
    ...createTtsRoutes(ctx),
    ...createSearchRoutes(ctx),
    ...createModelsRoutes(ctx),
    ...createImageRoutes(ctx),
    ...createOutputsRoutes(ctx),
  ];
};
