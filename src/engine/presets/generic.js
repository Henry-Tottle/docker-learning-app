'use strict';
// A deliberately skeletal preset for "some other stack". It teaches the shape
// of a Dockerfile and leaves the stack-specific lines as clearly marked
// placeholders the user must adapt.
const { line, blank } = require('../lines');
const { composeLines, dockerignoreLines } = require('../compose');

const BASE = 'debian:bookworm-slim';
const PORT = 8080;

function build({ database, target }) {
  const df = [];
  const prod = target === 'prod';
  df.push(
    blank(
      'df-base',
      'FROM ___',
      BASE,
      'A pinned, minimal Debian as the starting point. If an official image exists for your runtime (golang, ruby, eclipse-temurin, rust...), prefer it: it has the runtime installed correctly and kept patched. Whatever you choose, pin the version.',
      {
        concept: 'base-images',
        prompt: 'image:tag',
        accept: [/^(debian|ubuntu|alpine|golang|ruby|rust|eclipse-temurin|openjdk|php|elixir|dotnet\/sdk|mcr\.microsoft\.com\/dotnet\/[a-z]+):[\w.-]+$/],
        hint: 'Any official image with an explicit version tag: name:version. The one thing that is wrong is no tag or :latest.',
        feedback: [
          { match: /:latest$/, why: 'latest changes without warning. Pin a version.' },
          { match: /^[a-z0-9/.-]+$/, why: 'No tag means :latest. Add an explicit version after the colon.' },
        ],
      }
    )
  );
  df.push(line('df-workdir', 'WORKDIR /app', 'Creates /app and makes it the current directory for every later instruction, so relative paths in COPY, RUN and CMD are predictable.'));
  df.push(
    line(
      'df-manifest',
      '# TODO: COPY only your dependency manifest here (go.mod, Gemfile, pom.xml...)',
      'Copy the file that lists dependencies before the rest of the source, so the install step below is cached until dependencies change. This is the most important ordering rule in any Dockerfile.',
      { concept: 'layer-caching' }
    )
  );
  df.push(
    line(
      'df-install',
      '# TODO: RUN your dependency install command here',
      'The install step. Run it in one RUN instruction and clean any package-manager cache in the same instruction, so the cache is never stored in a layer.',
      { concept: 'layer-caching' }
    )
  );
  df.push(line('df-copy-src', 'COPY . .', 'Now the source, which changes most often, so it comes last. .dockerignore decides what "." includes.', { concept: 'layer-caching' }));
  if (prod) {
    df.push(
      line(
        'df-useradd',
        'RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app',
        'Debian images have no unprivileged account, so one is created and given the app folder.',
        { concept: 'non-root-user' }
      )
    );
    df.push(
      blank('df-user', 'USER ___', 'appuser', 'Switches away from root before the app starts. Setup steps above needed root; the running app does not.', {
        concept: 'non-root-user',
        prompt: 'user name',
        hint: 'The account created by the useradd line above.',
        feedback: [{ match: /^root$/, why: 'root is the default and what this line exists to avoid.' }],
      })
    );
  }
  df.push(
    blank('df-expose', 'EXPOSE ___', String(PORT), `Documentation: records that the app listens on ${PORT}. Publishing happens in compose. Change it to whatever your app really binds.`, {
      concept: 'expose-vs-publish',
      prompt: 'port',
      accept: [/^\d{2,5}$/],
      hint: 'The port your app listens on inside the container. The compose ports: line has the same number on its right-hand side.',
      feedback: [{ match: /:/, why: 'EXPOSE takes only the container port; the host:container mapping belongs in compose.' }],
    })
  );
  df.push(
    line(
      'df-cmd',
      '# TODO: CMD ["your-binary", "--flag"]  (JSON form, bind 0.0.0.0)',
      'The command that starts the app, in JSON ("exec") form so it runs as process 1 and receives stop signals. Bind to 0.0.0.0, not localhost: inside a container localhost is the container itself.',
      { concept: 'expose-vs-publish' }
    )
  );

  const compose = composeLines({ appType: 'generic', database, target, port: PORT, devMounts: [] });
  const dockerignore = dockerignoreLines({ ignore: [] });
  return { dockerfile: df, compose, dockerignore, port: PORT };
}

module.exports = { build, PORT, BASE };
