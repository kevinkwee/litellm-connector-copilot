/* eslint-disable no-undef */
import { defineConfig } from '@vscode/test-cli';

// Use VS Code Insiders so the test host matches the extension's `engines.vscode`
// requirement. Insiders stays ahead of the minimum supported stable version.
export default defineConfig({
  version: 'insiders',
  files: 'out/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true,
    reporter: process.env.VSCODE_TEST_RESULTS_DIR ? 'mocha-multi-reporters' : 'spec',
    reporterOptions: process.env.VSCODE_TEST_RESULTS_DIR ? {
      reporterEnabled: 'spec, mocha-junit-reporter',
      mochaJunitReporterReporterOptions: {
        mochaFile: `${process.env.VSCODE_TEST_RESULTS_DIR}/test-results.xml`
      }
    } : undefined
  }
});