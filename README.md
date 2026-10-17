<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## CAD Conversion API (DWG -> Vector PDF / DXF)

The backend exposes `POST /api/cad/convert` with a multipart field named `file` (up to 100 MB).

### 1. Vector PDF (Default for Mobile & Web)
By default, the endpoint converts the drawing to a high-precision **Vector PDF** (using QCAD Teigha engine) and streams it directly to the client with `Content-Type: application/pdf`:

```bash
# Upload DWG and directly receive Vector PDF (A0 sheet size by default)
curl -X POST "http://localhost:3000/api/cad/convert?paper=A0" \
  -F "file=@/path/to/project.dwg" \
  -o "project.pdf"
```

In Flutter:
```dart
var formData = FormData.fromMap({
  'file': await MultipartFile.fromFile(dwgPath, filename: 'proje.dwg'),
});

var response = await dio.post(
  'http://localhost:3000/api/cad/convert',
  data: formData,
  options: Options(responseType: ResponseType.bytes),
);

await File(pdfSavePath).writeAsBytes(response.data);
// Render with pdfx or flutter_pdfview at 60 FPS with infinite zoom!
```

### 2. DXF Output
If DXF format is explicitly required, pass `?format=dxf`:
```bash
curl -X POST "http://localhost:3000/api/cad/convert?format=dxf" \
  -F "file=@/path/to/project.dwg" \
  -o "project.dxf"
```

### Standalone Python DWG -> DXF conversion
For local batch/manual conversion, the Python CLI in
[`python/dwg_worker/convert_to_dxf.py`](./python/dwg_worker/convert_to_dxf.py)
uses LibreDWG to convert the file and `ezdxf` to confirm that the output can be
read, audit its structure, and write a JSON report. The input DWG is never
modified. If the preferred DXF version fails validation, it tries LibreDWG's
native version, R2000 compatibility, and minimal-DXF modes.

Alongside DXF, the parser creates `project.scene.json` for mobile rendering.
The versioned `sefim-cad-scene/1` model includes drawing extents, unit code,
layer visibility/style, block definitions, and common 2D entities (lines,
polylines including bulges, arcs, circles, ellipses, splines, points, text,
dimensions, and inserts). `GET /api/cad/drawings/:id/scene` serves the saved
model; the `format=json` conversion response includes `mobileSceneUrl`.
Unsupported entities and the scene-size cap are reported in `warnings`; use
the DXF URL to access the complete converted drawing.

Install LibreDWG (`libredwg-tools` on supported Debian/Ubuntu releases) and the
Python dependencies in the project environment:

```bash
python3 -m venv .venv-dwg
.venv-dwg/bin/python -m pip install -r python/dwg_worker/requirements.txt
.venv-dwg/bin/python python/dwg_worker/convert_to_dxf.py /path/to/project.dwg
```

This creates `project.dxf`, `project.scene.json`, and `project.report.json`
beside the source. Existing outputs are protected by default; use `--overwrite` to replace them. Use
`--version r2013` to select another preferred DXF version, `--converter
/path/to/dwg2dxf` when it is not on `PATH`, or `--help` for all options.
LibreDWG is GPL-3.0-or-later; review the license implications before bundling
it with a commercial product. A readable DXF and a clean structural audit do
not guarantee lossless fidelity: proxy/AEC objects, dimensions, fonts, and
other application-specific content still need comparison with the source in a
CAD viewer.

The same converter is called automatically by `POST /api/cad/convert` when
`format=dxf` is requested (and by the default `auto` flow when it chooses DXF).
Alternative QCAD/LibreDWG outputs are also checked with `ezdxf` after any
viewing optimization, so the API does not return an unreadable DXF.
Set `DWG_PYTHON_PATH=.venv-dwg/bin/python` in the backend environment so the
server uses the project's interpreter and installed `ezdxf` dependency. On
Windows, point it to `.venv-dwg/Scripts/python.exe`. `GET /api/cad/status`
reports whether Python, `ezdxf`, the script, and `dwg2dxf` are available.
This is the project's own CAD scene parser/API model, but DWG binary decoding
still relies on LibreDWG; it is not a from-scratch implementation of every
proprietary DWG version or custom AEC object.

### 3. JSON Output (Temporary Download URL)
If metadata or a deferred download is needed, pass `?format=json`:
```json
{
  "success": true,
  "fileId": "8f32c1...",
  "fileName": "project.dxf",
  "format": "dxf",
  "downloadUrl": "/api/cad/drawings/<drawing-id>/download",
  "mobileSceneUrl": "/api/cad/drawings/<drawing-id>/scene"
}
```

Download the saved DXF and mobile scene from the returned URLs. The temporary
conversion artifact is also available via `GET /api/cad/files/:fileId`.

### Diagnostics Endpoint
Check available converters and engine status:
```bash
GET /api/cad/status
```

## Column photo analysis API

`POST /column/analyze` accepts an image in the multipart `file` field. The
initial implementation is TypeScript-only and uses `sharp` for image decoding
plus a low-confidence contrast heuristic. It does not claim to identify
reinforcement reliably without a trained vision model.

Optional multipart calibration fields can convert pixel measurements to mm:

```text
referenceWidthPx=2400
referenceWidthMm=300
```

The response includes `bars.verticalCount` for vertical reinforcement and
`bars.horizontalCount` for horizontal reinforcement/stirrup candidates. These
are heuristic counts until a trained detection model is connected.

For production, the response keeps `estimated: true`; `edge`/cover remains
`null` until the column boundary and a physical scale are known. This contract
can later be backed by a Python/OpenCV or hosted model without changing the
Flutter endpoint.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

To add it to this project:

```bash
$ npm install @nestjs/observe
```

Then follow the [setup guide](https://docs.nestjs.com/observability/overview) - it takes a single import and an app key.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
