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

## CAD conversion API

The backend exposes `POST /api/cad/convert` with a multipart field named `file`.
Only `.dwg` files up to 100 MB are accepted. The API runs the LibreDWG
`dwg2dxf` executable and returns a temporary download URL:

```json
{
  "success": true,
  "fileId": "8f32c1...",
  "fileName": "proje.dxf",
  "downloadUrl": "/api/cad/files/8f32c1..."
}
```

Install LibreDWG on the server and make `dwg2dxf` available on `PATH`. Set
`CAD_CONVERTER_COMMAND` when the executable has a different path. Conversion
jobs time out after 60 seconds, at most three run concurrently, and generated
files are removed after ten minutes. The in-memory file registry is intended
for the initial single-process prototype; a queue and persistent metadata store
should be introduced before running multiple backend instances.

The conversion does not use LibreDWG's `--minimal` mode, so drawing entities
including `TEXT` and `MTEXT` are included in the DXF output. If the DXF contains
these entities but they are not visible in Flutter, the Flutter DXF parser or
renderer must support `TEXT`/`MTEXT` and the referenced font styles.

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

## Delivery-note OCR

`POST /delivery-notes` accepts an image in the multipart `photo` field (up to
15 MB) and requires `Authorization: Bearer <accessToken>`. The verified token's
`sub` user ID is saved as `DeliveryNote.createdById`. It stores the image, calls the Python EasyOCR service, and saves the
recognized text and extracted header fields to `DeliveryNote`. Start the OCR
service in a separate process:

```bash
python3 -m venv .venv-ocr
source .venv-ocr/bin/activate
pip install -r requirements-ocr.txt
python3 ocr/ocr_service.py
```

The first start downloads EasyOCR's Turkish and English models. The backend
uses `OCR_SERVICE_URL` if set; otherwise it calls `http://127.0.0.1:8010`.
The parser follows the supplied script's date, time, dispatch number, truck
plate, concrete strength and production quantity rules. The supplied script
does not extract order quantity or individual material rows, so those remain
empty; `rawText` stores the full OCR output for review. OCR failures leave the
uploaded delivery note in `failed` status.

## Authentication

The backend exposes:

- `POST /auth/signup` with `email`, `password`, and optional `username`/`name`
- `POST /auth/login` with `email` and `password`

Both endpoints return an `accessToken` and the public user fields. Set a strong
`JWT_SECRET` in the environment before starting the application. For local
development, copy `.env.example` to `.env` and replace the placeholder with a
long random value. After changing the Prisma contract, run
`npm run contract:emit` and apply the database schema change with the Prisma
migration workflow for the configured database.

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
