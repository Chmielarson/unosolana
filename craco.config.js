// craco.config.js
const webpack = require('webpack');

module.exports = {
  webpack: {
    configure: {
      resolve: {
        fallback: {
          crypto: require.resolve('crypto-browserify'),
          stream: require.resolve('stream-browserify'),
          os: require.resolve('os-browserify/browser'),
          http: require.resolve('stream-http'),
          https: require.resolve('https-browserify'),
          zlib: require.resolve('browserify-zlib'),
          path: require.resolve('path-browserify'),
          fs: false,
          buffer: require.resolve('buffer/'),
        },
      },
      plugins: [
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        }),
      ],
    },
  },
};