// CloudFront Function, runtime cloudfront-js-2.0, viewer-request event.
// The two host placeholders below are filled in at synth time (lib/viewer-request.ts).
var APEX_HOST = '__APEX_HOST__';
var WWW_HOST = '__WWW_HOST__';

function serializeQuerystring(querystring) {
  var parts = [];
  for (var name in querystring) {
    var param = querystring[name];
    var values = param.multiValue || [param];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? name : name + '=' + values[i].value);
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';

  // One canonical hostname: send www to the apex, keeping path and query.
  if (host === WWW_HOST) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://' + APEX_HOST + request.uri + serializeQuerystring(request.querystring) },
        'cache-control': { value: 'max-age=3600' },
      },
    };
  }

  // Map directory-style paths to their prerendered index.html. Anything that
  // does not exist falls through to S3's 404 and the distribution's /404.html.
  var uri = request.uri;
  if (uri.indexOf('/.well-known/') === 0) {
    return request;
  }
  if (uri.charAt(uri.length - 1) === '/') {
    request.uri = uri + 'index.html';
  } else if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {
    request.uri = uri + '/index.html';
  }
  return request;
}
