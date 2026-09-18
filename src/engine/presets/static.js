'use strict';
// A static site: HTML/CSS/JS with no server-side code. Served by nginx.
const { line, blank } = require('../lines');
const { composeLines, dockerignoreLines } = require('../compose');

const BASE = 'nginx:1.27-alpine';
const PORT = 80;

function build({ target }) {
  const df = [];
  df.push(
    blank(
      'df-base',
      'FROM ___',
      BASE,
      'nginx is a web server that does one job well: serving files fast. The official image is pinned to a version, and -alpine is a very small Linux variant: fine here because nginx needs nothing else installed.',
      {
        concept: 'base-images',
        prompt: 'image:tag',
        accept: [/^nginx:1\.\d+(\.\d+)?(-alpine(-slim)?|-bookworm|-perl)?$/, /^caddy:2(\.\d+)*(-alpine)?$/, /^httpd:2(\.\d+)*(-alpine)?$/],
        hint: 'A web server image (nginx is the usual choice), pinned to a version, ideally the tiny alpine variant.',
        feedback: [
          { match: /^nginx:latest$|^nginx$/, why: 'No pin means whatever nginx released last. Pin a version so rebuilds are predictable.' },
          { match: /^node|^python/, why: 'A static site has no server-side code to run. It needs a file server, not a language runtime.' },
          { match: /^(ubuntu|debian|alpine)/, why: 'You would then have to install and configure a web server yourself. The official nginx image is already set up to serve files.' },
        ],
      }
    )
  );
  df.push(
    blank(
      'df-copy',
      'COPY . ___',
      '/usr/share/nginx/html',
      'nginx in this image serves whatever is in /usr/share/nginx/html. Copying the site there is the entire "install". Because there is no dependency step, layer ordering barely matters here: there is only one layer that changes.',
      {
        concept: 'layer-caching',
        prompt: 'destination path',
        accept: ['/usr/share/nginx/html/'],
        hint: 'The folder the official nginx image serves files from. It is documented on the image\'s Docker Hub page: /usr/share/nginx/<something>.',
        feedback: [
          { match: /^\/app/, why: '/app is a convention for app code that a runtime executes. nginx only serves files from its configured root, which is /usr/share/nginx/html.' },
          { match: /^\.$|^\.\//, why: 'That is the source side. The destination has to be the folder nginx serves from.' },
          { match: /var\/www/, why: 'That is the Debian default for a hand-installed nginx. The official image is configured for /usr/share/nginx/html.' },
        ],
      }
    )
  );
  df.push(
    blank(
      'df-expose',
      'EXPOSE ___',
      '80',
      'Documentation: nginx listens on 80 inside the container. It opens nothing by itself; compose publishes the port. There is no CMD because the nginx image already defines one that starts the server.',
      {
        concept: 'expose-vs-publish',
        prompt: 'port',
        hint: 'The standard HTTP port nginx listens on by default.',
        feedback: [
          { match: /:/, why: 'EXPOSE takes only the container port. The host:container mapping belongs in compose.' },
          { match: /^(3000|8000|8080)$/, why: 'Those are conventional app ports. nginx in this image listens on the standard HTTP port.' },
        ],
      }
    )
  );

  const compose = composeLines({ appType: 'static', database: 'none', target, port: PORT, hostPort: 8080, devMounts: [] });
  // For a static site the dev bind mount goes to nginx's html dir, not /app.
  const bind = compose.find((l) => l.id === 'c-bind');
  if (bind) {
    bind.text = '      - .:/usr/share/nginx/html:ro';
    bind.blank.template = '      - ___:/usr/share/nginx/html:ro';
    bind.explain = 'A bind mount of the current folder over the folder nginx serves. Edit a file, refresh the browser. :ro makes it read-only inside the container, since nginx never needs to write to your source.';
  }
  const dockerignore = dockerignoreLines({
    ignore: [line('i-node-modules', 'node_modules', 'If the site uses a bundler, its dependencies are not something nginx should serve. Only the built output belongs in the image.', { concept: 'dockerignore' })],
  });
  return { dockerfile: df, compose, dockerignore, port: PORT };
}

module.exports = { build, PORT, BASE };
