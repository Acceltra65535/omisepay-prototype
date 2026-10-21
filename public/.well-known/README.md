# Apple Pay 域名验证文件说明 (Apple Pay Domain Association)

当您在 Apple Pay on the Web 中使用 Omise SG 时：

1. 向 Omise 客服（support@omise.co）或您的专属客户经理报备您的独立域名（例如：`pay.yourdomain.com`）。
2. Omise 在其 Apple 开发者后台绑定该域名后，会将 Apple 提供的验证文件 `apple-developer-merchantid-domain-association` 发给您。
3. 请将该文件直接保存在本目录下：
   `public/.well-known/apple-developer-merchantid-domain-association`
4. 部署后，确保公网通过浏览器直接能访问到：
   `https://[您的域名]/.well-known/apple-developer-merchantid-domain-association`
5. 通知 Omise 完成苹果端的域名验证即可。
