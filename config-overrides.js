const webpack = require('webpack');

module.exports = function override(config) {
  // Dodaj fallback dla modułów Node.js
  const fallback = config.resolve.fallback || {};
  Object.assign(fallback, {
    crypto: require.resolve('crypto-browserify'),
    stream: require.resolve('stream-browserify'),
    buffer: require.resolve('buffer'),
    process: require.resolve('process/browser'),
    zlib: require.resolve('browserify-zlib'),
    path: require.resolve('path-browserify'),
    os: require.resolve('os-browserify/browser'),
    http: require.resolve('stream-http'),
    https: require.resolve('https-browserify'),
    vm: require.resolve('vm-browserify'),  // Dodane VM
    fs: false
  });
  config.resolve.fallback = fallback;
  
  // Dodaj plugin do obsługi Buffer i process
  config.plugins = (config.plugins || []).concat([
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer']
    })
  ]);
  
  // Dodaj konfigurację dla modułów ESM
  config.module.rules.push({
    test: /\.m?js/,
    resolve: {
      fullySpecified: false
    }
  });
  
  return config;
};