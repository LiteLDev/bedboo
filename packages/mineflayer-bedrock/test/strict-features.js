// owner: U4 (core runtime) — mocha 'require' hook of .mocharc.json and .mocharc.e2e.json
'use strict'
// Test runs use the strict Bedrock feature table (docs/differences/U2.md#feature-table): bot.supportFeature
// throws on a Java feature name the table does not know instead of warning once (set it to 0 to opt out).
if (process.env.BEDBOO_STRICT_FEATURES === undefined) process.env.BEDBOO_STRICT_FEATURES = '1'
