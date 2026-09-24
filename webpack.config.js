const path = require('path');

const mainConfig = {
  entry: './src/main.ts',
  target: 'electron-main',
  devtool: false,
  module: {
    rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }]
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  output: { filename: 'main.js', path: path.resolve(__dirname, 'dist') },
  externals: {
    electron: 'commonjs2 electron',
    'electron-store': 'commonjs electron-store',
    'pdf-parse': 'commonjs pdf-parse',
    'pdf-parse/node': 'commonjs pdf-parse/node',
    'mammoth': 'commonjs mammoth',
    'fs-extra': 'commonjs fs-extra'
  }
};

const preloadConfig = {
  entry: './src/preload.ts',
  target: 'electron-preload',
  devtool: false,
  module: {
    rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }]
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  output: { filename: 'preload.js', path: path.resolve(__dirname, 'dist') },
  externals: {
    electron: 'commonjs2 electron'
  }
};

module.exports = [mainConfig, preloadConfig];
