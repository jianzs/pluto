# Pluto 与其他产品的区别

## 与 BaaS 类产品的区别

典型产品：Supabase、Appwrite。

在 BaaS 领域，专注于该领域的产品通常提供自管数据库、文件存储等组件。用户可以在后台创建这些组件的实例，并提供相应的客户端 SDK 来接入这些实例。此外，这些产品可能还提供后台数据可视化的功能。

如果你不担心供应商锁定的问题，并且也没有服务部署的顾虑，那么 BaaS 产品可以提供不错的编写体验。你可以轻松创建数据库等组件实例，编程时只需要关注组件的调用方法。

与这类产品相比，Pluto 则帮助开发者在目标云平台上创建属于自己账户的基础设施环境。同时，Pluto 还提供与 BaaS 产品一致的编写体验。

## 与 PaaS 类产品的区别

典型产品：Fly.io、render、Heroku、[LeptonAI](https://lepton.ai)。

与 Fly.io、render、Heroku、LeptonAI 等 PaaS 产品相比，Pluto 不专注于应用托管，而是通过编译生成细粒度的计算模块，并从代码中推导出应用对基础设施的资源需求，然后整合使用云平台已经提供的、丰富的原子能力，例如 FaaS、对象存储、KV 数据库等，不需要用户编写额外配置代码即可将应用部署到云平台上。

LeptonAI 是一个 AI 基础设施平台，允许开发者将 AI 应用定义在一个 Python Class 中，此类 Class 称为 Photon。LeptonAI 通过在 Photon 中默认提供了 `requirement_dependency`、`system_dependency`、`image` 等属性的方式，使开发者可以自定义模型镜像，配置基础依赖环境等。并且，LeptonAI 允许开发者在方法中操作 Transformer Pipline 等，对于具备 AI 模型研发经验，且需要对模型细粒度控制的研发者相对友好。此外，LeptonAI 正在研发消息队列、KV 数据库、对象存储等能力，并以控制台申请的方式实现资源创建。

Pluto 并不参与基础设施平台的建设工作，而是作为一个研发工具，将基础设施已经提供的、丰富的原子能力以更友好的方式提供到用户的编程界面。AWS、阿里云、K8s 等现有的云平台已经提供了 GPU 实例、消息队列、对象存储等基础服务，但由于没有提供给开发者一个整合后的研发界面，导致丰富的能力难以使用。Pluto 则将这些能力以统一的编程界面提供给开发者，然后从应用代码中推导出应用对基础设施的资源需求，进而帮助开发者自动地在云平台上创建与部署资源实例，简化资源创建和应用部署流程。在编程界面上，Pluto 尽量不限制用户编程习惯，提供类似研发 Web 应用的体验，通过创建对象的方式完成资源定义，并通过函数参数的方式完成基础依赖环境的配置，减少硬编码的存在。Pluto 后续也将进一步放松编程约束，提供类似开发本地单体应用的研发体验。

## 与脚手架工具的区别

典型产品：Serverless Framework、Serverless Devs。

与 Serverless Framework、Serverless Devs 等脚手架工具相比，Pluto 没有针对具体云厂商、具体框架提供应用编程框架，而是给用户提供一致的编程界面，利用语言技术最终生成适配云厂商的计算模块，并支持在不修改代码的情况下在云平台间迁移。

## 与 IfC 类产品的区别

### 纯注释 IfC 类产品

典型产品：Klotho。

与 Klotho 等基于纯注释的 IfC 产品相比，Pluto 直接从用户代码中推导资源依赖，能够提供更一致的编程体验。同时，编程语言的依赖机制能够带来更高的横向扩展性。

### 基于动态分析的 IfC 类产品

典型产品：Shuttle、Nitric、[Winglang](https://www.winglang.io/)。

基于动态分析的 IfC 产品又有 EDSL 与 DSL 两类：

1. Shuttle、Nitric、Winglang 的 TypeScript 版本等属于 EDSL 类产品，该类产品通常提供一套常用编程语言的 SDK，用户使用这套 SDK，并配合提供的 CLI，就能够使产品从用户代码中获取应用对基础设施的资源需求。
2. Winglang 的 wing 语言版本则属于 DSL 类产品，该产品通过语言关键字（preflight、inflight）的形式将云的概念提供给开发者，同时仍通过一组与云相关的 wing 语言 SDK 来将云的能力透出给开发者。Winglang 最终将 wing 代码编译成 js 代码，并采用与 EDSL 相同的方式获取应用对基础设施的资源需求。

基于动态分析的 IfC 产品都需要在编译时执行用户代码，才能够获取到应用对基础设施的资源需求，这导致开发者需要在编程时感知并关注编译时与运行时之间的区别，根据代码的预期执行时机将其放置在合适的位置，避免运行时代码在编译时被执行，或编译时代码在运行时被执行。

Pluto 提供了不同编程语言的 EDSL 解决方案，目前支持 TypeScript 和 Python 两种编程语言，但 Pluto 采用了静态分析的方式，通过类层次分析、数据流分析等手段，从应用代码中直接推导出应用对基础设施的资源需求，进一步根据应用资源需求与云平台交互，自动地完成基础设施的创建与配置。这种方式在编译时不需要执行用户代码，因此开发者在编程时不需要关心代码的执行时机，降低开发者的认知成本。此外，EDSL 相较于 DSL 的方式能够更便捷地享受到现有生态的红利。
