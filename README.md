# CloudSync-DNS
用来将Cloudflare 所有记录自动同步至 ClouDNS 实现双向解析变单向
### 1. 无服务器架构

CloudSync DNS 基于 Cloudflare Workers 构建，具有以下优势：

- 无需维护服务器
- 全球分布式部署，低延迟
- 自动扩展，应对任何规模的需求
- 高可用性，99.99% 的运行时间保证


### 2. 安全性

- 所有 API 通信均通过 HTTPS 加密
- 支持 API 令牌认证，遵循最小权限原则
- 不存储敏感凭据，通过环境变量安全传递

### 4. 可扩展性

- 模块化设计，易于添加新功能
- 支持通过 Webhook 与其他系统集成
- 可自定义同步逻辑，适应不同需求

## 高级功能

### 1. 智能记录处理

CloudSync DNS 能够智能处理各种复杂的 DNS 记录类型，包括：

- **MX 记录**：正确处理优先级字段
- **SRV 记录**：处理优先级、权重和端口字段
- **CAA 记录**：处理标志和标签字段
- **NAPTR 记录**：处理顺序、偏好、标志、服务和正则表达式字段

### 2. 差异比较

系统会在同步前执行智能差异比较，确保只更新实际发生变化的记录，减少不必要的 API 调用和潜在的服务中断。

### 3. 同步策略

提供多种同步策略选项：

- **增量同步**：只添加、更新或删除变化的记录
- **全量同步**：完全重建目标 DNS 服务的记录
- **单向同步**：从源服务到目标服务的单向数据流
- **双向同步**：在两个 DNS 服务之间保持记录一致

### 4. 通知系统

支持通过 Webhook 发送同步状态通知，可以集成到：

- Slack
- Discord
- Microsoft Teams
-自定义 HTTP 端点

### 5. 记录过滤

可以配置记录过滤规则，排除特定类型的记录或特定域名前缀的记录，使同步更加精确。

## 技术实现细节

### 1. 记录比对算法

CloudSync DNS 使用智能比对算法，考虑以下因素：

- 记录类型
- 主机名（考虑根域名 @ 符号和完全限定域名的差异）
- 记录内容
- TTL 值（允许小范围差异）
- 特殊字段（如 MX 优先级、SRV 参数等）

### 2. 错误处理

实现了全面的错误处理机制：

- API 错误捕获和分类
- 重试逻辑，处理临时故障
- 详细的错误报告，便于故障排查
- 同步事务管理，确保数据一致性

### 3. 性能优化

- 批量处理 API 请求，减少网络往返
- 缓存 DNS 记录，减少重复查询
- 增量同步，最小化 API 调用
- 异步处理，提高响应速度

### 4. 用户界面

提供直观的 Web 界面，包括：

- 实时同步状态和进度
- 详细的同步历史记录
- DNS 记录比较视图
- 配置管理界面
- 健康状态监控
### 环境变量配置
是的，您理解得非常正确！**不能也不应该直接在 `worker.js` 代码文件中更改 ClouDNS 和 Cloudflare 的 API 密钥、密码等敏感配置信息。**

这样做有几个主要原因：

1.  **安全性**：将 API 密钥、密码等硬编码到代码中，一旦代码泄露（例如上传到公开的代码仓库），您的账户安全将受到严重威胁。
2.  **可维护性**：如果配置信息更改（例如更换了 API 密钥），您就需要修改代码并重新部署 Worker，这非常不方便。
3.  **环境隔离**：通常开发、测试和生产环境会有不同的配置。使用环境变量可以轻松为不同环境设置不同的值，而无需更改代码。

**您需要通过 Cloudflare Workers 的环境变量 (Environment Variables / Secrets) 来配置这些信息。** 对于特别敏感的信息，如 API 密钥和密码，Cloudflare 提供了 "Secrets" 类型的环境变量，它们在存储时会被加密。

**具体操作步骤如下：**

1.  **登录到您的 Cloudflare Dashboard。**

2.  **导航到 Workers & Pages**：
    *   在左侧菜单栏中找到并点击 "Workers & Pages"。

3.  **选择您的 Worker 服务**：
    *   在列表中找到您部署这个 `worker.js` 脚本的 Worker 服务，并点击它。

4.  **进入设置 (Settings)**：
    *   在您的 Worker 服务页面，点击顶部的 "Settings" (设置) 选项卡。

5.  **找到变量 (Variables) 部分**：
    *   在 "Settings" 页面中，向下滚动找到 "Variables" (变量) 部分。
    *   您会看到 "Environment Variables" (环境变量) 和 "KV Namespace Bindings" (KV 命名空间绑定) 等。

6.  **添加环境变量 (或 Secrets)**：
    *   对于 API 密钥和密码，强烈建议点击 "Secrets" 下的 "Add secret" (添加密钥)。对于不那么敏感的配置（如域名、同步间隔），可以使用 "Environment Variables" 下的 "Add variable" (添加变量)。
    *   您需要为脚本中 `loadConfig(env)` 函数读取的每一个 `env.VARIABLE_NAME` 添加对应的环境变量。

    以下是您需要添加的变量名、建议类型以及它们对应的用途：

    | 变量名 (Variable Name)     | 类型 (Type)        | 描述                                                                 | 示例值 (仅供参考)         |
    | :------------------------- | :----------------- | :------------------------------------------------------------------- | :------------------------ |
    | `CLOUDNS_AUTH_ID`          | Secret 或 Text     | 您的 ClouDNS 主 API 用户 ID (如果您不使用子账户)                         | `12345`                   |
    | `CLOUDNS_SUB_AUTH_ID`      | Secret 或 Text     | 您的 ClouDNS API 子用户 ID (如果您使用子账户，则此项会覆盖 `CLOUDNS_AUTH_ID`) | `67890`                   |
    | `CLOUDNS_AUTH_PASSWORD`    | **Secret**         | 对应 `CLOUDNS_AUTH_ID` 或 `CLOUDNS_SUB_AUTH_ID` 的密码                 | `your_cloudns_password`   |
    | `CLOUDNS_DOMAIN_NAME`      | Text               | 您要在 ClouDNS 上同步的域名                                              | `example.com`             |
    | `CLOUDFLARE_API_TOKEN`     | **Secret**         | 您的 Cloudflare API Token (具有编辑 DNS 权限)                            | `your_cloudflare_api_token` |
    | `CLOUDFLARE_ZONE_ID`       | Text               | 您的 Cloudflare Zone ID                                                  | `your_cloudflare_zone_id` |
    | `CLOUDFLARE_EMAIL`         | Text 或 Secret     | 您的 Cloudflare 账户邮箱 (脚本中有此配置，但对于 API Token 认证通常不是必需的) | `user@example.com`        |
    | `SYNC_INTERVAL`            | Text (可选)        | 同步间隔（秒），默认为 3600                                              | `1800` (30分钟)           |
    | `SYNC_DIRECTION`           | Text (可选)        | 同步方向，默认为 'cloudflare-to-cloudns'                                 | `cloudflare-to-cloudns`   |
    | `SYNC_MODE`                | Text (可选)        | 同步模式，默认为 'incremental' (增量) 或 'full' (全量)                   | `incremental`             |
    | `ENABLE_NOTIFICATIONS`     | Text (可选)        | 是否启用通知，填 'true' 或 'false'                                       | `true`                    |
    | `NOTIFICATION_WEBHOOK`     | Text (可选)        | 如果启用通知，则为接收通知的 Webhook URL                                 | `https://your.webhook.url` |
    | `DEBUG`                    | Text (可选)        | 是否开启调试模式，填 'true' 或 'false'                                   | `false`                   |

    **如何添加：**
    *   **Variable name**：输入上面表格中的变量名。
    *   **Value**：输入对应的值。
    *   对于 Secret 类型的变量，Cloudflare 会对其进行加密。
    *   点击 "Save" (保存) 或 "Encrypt and save" (加密并保存)。

7.  **脚本如何读取这些变量**：
    您的 `worker.js` 文件中的 `loadConfig(env)` 函数就是用来读取这些环境变量的。当 Cloudflare Worker 运行时，它会将您在 Dashboard 中设置的环境变量和 Secrets 注入到 `env` 对象中。
    例如，代码中的 `env.CLOUDNS_AUTH_ID` 就会自动获取您在 Dashboard 中设置的名为 `CLOUDNS_AUTH_ID` 的环境变量的值。

**关于 KV Namespace：**

您的脚本中也提到了 `env.KV_CACHE` 和 `env.KV_METRICS`，这表明脚本设计上还期望使用 Cloudflare KV Namespace 来进行缓存和指标记录。

*   **KV Namespace (KV 命名空间)**：是一种全局的、低延迟的键值数据存储。
*   **创建 KV Namespace**：
    1.  在 Cloudflare Dashboard 的 "Workers & Pages" 页面，点击左侧的 "KV"。
    2.  点击 "Create a namespace" (创建命名空间)。
    3.  为您的 KV 命名空间命名，例如 `my_dns_sync_cache` 用于缓存，`my_dns_sync_metrics` 用于指标。
*   **绑定 KV Namespace 到您的 Worker**：
    1.  回到您的 Worker 服务的 "Settings" -> "Variables" 页面。
    2.  向下滚动到 "KV Namespace Bindings" (KV 命名空间绑定) 部分。
    3.  点击 "Add binding" (添加绑定)。
    4.  **Variable name** (变量名称)：输入脚本中使用的名称，即 `KV_CACHE`。
    5.  **KV namespace**：从下拉列表中选择您刚刚创建的用于缓存的 KV 命名空间 (例如 `my_dns_sync_cache`)。
    6.  再次点击 "Add binding"，为 `KV_METRICS` 绑定对应的 KV 命名空间 (例如 `my_dns_sync_metrics`)。
    7.  保存更改。

**总结一下您需要做的：**

1.  **登录 Cloudflare Dashboard。**
2.  **为您的 Worker 添加必要的环境变量和 Secrets**，特别是 `CLOUDNS_AUTH_ID` (或 `CLOUDNS_SUB_AUTH_ID`) 和 `CLOUDNS_AUTH_PASSWORD`，以及 Cloudflare 的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ZONE_ID`。确保这些值是准确无误的，并且您 ClouDNS 账户的套餐支持 API 访问。
3.  **(可选但推荐，如果脚本功能需要)** 创建两个 KV Namespace (一个用于缓存，一个用于指标记录)，并将它们分别以 `KV_CACHE` 和 `KV_METRICS` 的变量名绑定到您的 Worker。

完成这些步骤后，您的 `worker.js` 脚本就能通过 `env` 对象安全地访问这些配置信息，而无需将它们硬编码在代码中。这样，之前的 API 权限错误（如果是由错误的凭证或未配置凭证间接引起的）也可能得到解决，但**最根本的还是要确保您的 ClouDNS 套餐支持 API 访问**。

## 部署场景

### 1. 多 DNS 提供商冗余

使用 CloudSync DNS 在 Cloudflare 和 ClouDNS 之间保持记录同步，实现 DNS 服务的冗余备份，提高可用性和灾难恢复能力。

### 2. 迁移辅助工具

在从一个 DNS 提供商迁移到另一个提供商的过程中，使用 CloudSync DNS 确保平滑过渡，减少服务中断风险。

### 3. 多环境管理

在开发、测试和生产环境之间同步 DNS 配置，确保环境一致性。

### 4. 自动化 DNS 管理

作为 CI/CD 流程的一部分，自动更新和同步 DNS 记录，支持基础设施即代码实践。

## 未来发展路线图

### 1. 多提供商支持

扩展支持更多 DNS 提供商：

- AWS Route 53
- Google Cloud DNS
- Azure DNS
- Namecheap
- GoDaddy

### 2. 高级同步规则

实现更复杂的同步规则：

- 基于记录类型的选择性同步
- 基于域名模式的过滤
- 自定义转换规则

### 3. 审计和合规

添加审计功能：

- 详细的变更日志
- 合规报告
- 变更审批流程

### 4. 高级监控

增强监控功能：

- 记录传播监控
- 性能指标
- 异常检测
- 自动修复

### 5. API 和集成

提供 API 和集成选项：

- REST API 用于外部控制
- Webhook 用于事件通知
- 与流行的 DevOps 工具集成

## 环境变量详细说明

### Cloudflare 配置

- **CLOUDFLARE_API_TOKEN**：Cloudflare API 令牌，需要具有 Zone.DNS 读写权限。可以在 Cloudflare 仪表板的"我的个人资料">"API 令牌"中创建。建议使用区域级别的令牌，仅授予所需的最小权限。

- **CLOUDFLARE_ZONE_ID**：Cloudflare 区域 ID，可以在 Cloudflare 仪表板的"概述"页面找到。这是一个唯一标识符，用于指定要同步的域名。

### ClouDNS 配置

- **CLOUDNS_AUTH_ID**：ClouDNS 认证 ID，用于 API 认证。可以在 ClouDNS 控制面板的"API"页面找到。

- **CLOUDNS_SUB_AUTH_ID**：ClouDNS 子用户认证 ID，如果使用子用户进行 API 认证，则使用此变量。与 CLOUDNS_AUTH_ID 二选一。

- **CLOUDNS_AUTH_PASSWORD**：ClouDNS API 密码，用于 API 认证。可以在 ClouDNS 控制面板的"API"页面设置。

- **CLOUDNS_DOMAIN_NAME**：要同步的 ClouDNS 域名，例如 "example.com"。

- ![1741507565602.png](https://img.picui.cn/free/2025/03/09/67cd4bf12a869.png)

### 同步配置

- **SYNC_INTERVAL**：自动同步的时间间隔，以秒为单位。默认为 3600 秒（1 小时）。

- **SYNC_DIRECTION**：同步方向，可选值：
  - `cloudflare-to-cloudns`：从 Cloudflare 同步到 ClouDNS（默认）
  - `cloudns-to-cloudflare`：从 ClouDNS 同步到 Cloudflare
  - `bidirectional`：双向同步

- **SYNC_MODE**：同步模式，可选值：
  - `incremental`：增量同步，只更新变化的记录（默认）
  - `full`：全量同步，删除所有目标记录后重新创建

### 通知配置

- **ENABLE_NOTIFICATIONS**：是否启用通知，可选值：`true` 或 `false`（默认）。

- **NOTIFICATION_WEBHOOK**：通知 Webhook URL，用于发送同步状态通知。支持 Slack、Discord 等服务的 Webhook URL。

### 调试配置

- **DEBUG**：是否启用调试模式，可选值：`true` 或 `false`（默认）。启用后会输出更详细的日志信息。

## 效果预览
- https://555.xiaoxing.us.kg/

## 结论

CloudSync DNS 是一个强大、灵活且用户友好的解决方案，用于在 Cloudflare 和 ClouDNS 之间同步 DNS 记录。它提供了全面的记录类型支持、多种同步选项、直观的 Web 界面和强大的自动化功能，满足各种 DNS 管理需求。

通过利用 Cloudflare Workers 的无服务器架构，CloudSync DNS 提供了高可用性、低成本和全球分布式部署的优势，使其成为现代 DNS 管理的理想选择。
