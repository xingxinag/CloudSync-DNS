// CloudSync DNS - Cloudflare 与 ClouDNS 同步工具
// 支持所有 Cloudflare DNS 记录类型的同步

// 配置管理
const CONFIG = {
  version: '2.0.0',
  defaultSyncInterval: 3600, // 默认同步间隔（秒）
  maxRetries: 3, // 最大重试次数
  retryDelay: 5000, // 重试延迟（毫秒）
  supportedRecordTypes: [
    'A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 
    'DNSKEY', 'DS', 'NAPTR', 'SMIMEA', 'SSHFP', 'TLSA', 'URI'
  ],
  // 记录类型特殊字段映射
  recordTypeFields: {
    'MX': ['priority'],
    'SRV': ['priority', 'weight', 'port'],
    'CAA': ['flags', 'tag'],
    'NAPTR': ['order', 'preference', 'flags', 'service', 'regexp']
  }
};

// 错误处理工具
class DNSSyncError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'DNSSyncError';
  }
}

// 同步进度类
class SyncProgress {
  constructor() {
    this.listeners = [];
    this.progress = {
      status: 'initializing',
      percentage: 0,
      message: '正在初始化...'
    };
  }
  
  addListener(callback) {
    this.listeners.push(callback);
    // 立即发送当前进度
    callback(this.progress);
  }
  
  update(progress) {
    this.progress = { ...this.progress, ...progress };
    this.notifyListeners();
  }
  
  fail(error) {
    this.progress = {
      status: 'failed',
      error: error.message,
      percentage: 100
    };
    this.notifyListeners();
  }
  
  notifyListeners() {
    for (const listener of this.listeners) {
      listener(this.progress);
    }
  }
}

// DNS记录同步类
class DNSSync {
  constructor(env) {
    // 从环境变量加载配置
    this.config = this.loadConfig(env);
    this.lastSyncTime = null;
    this.syncHistory = [];
    this.syncInProgress = false;
  }

  // 加载配置，支持环境变量和KV存储
  loadConfig(env) {
    // 基础配置
    const config = {
      ...CONFIG,
      clouDNS: {
        authId: env.CLOUDNS_AUTH_ID || env.CLOUDNS_SUB_AUTH_ID,
        authPassword: env.CLOUDNS_AUTH_PASSWORD,
        domainName: env.CLOUDNS_DOMAIN_NAME,
        baseUrl: 'https://api.cloudns.net/dns',
        useSubAuth: !!env.CLOUDNS_SUB_AUTH_ID
      },
      cloudflare: {
        apiToken: env.CLOUDFLARE_API_TOKEN,
        zoneId: env.CLOUDFLARE_ZONE_ID,
        baseUrl: 'https://api.cloudflare.com/client/v4',
        email: env.CLOUDFLARE_EMAIL
      },
      syncInterval: parseInt(env.SYNC_INTERVAL || CONFIG.defaultSyncInterval),
      syncDirection: env.SYNC_DIRECTION || 'cloudflare-to-cloudns',
      syncMode: env.SYNC_MODE || 'incremental',
      enableNotifications: env.ENABLE_NOTIFICATIONS === 'true',
      notificationWebhook: env.NOTIFICATION_WEBHOOK,
      debug: env.DEBUG === 'true'
    };

    // 不再调用验证方法
    // this.validateConfig(config);
    
    return config;
  }

  // 获取 Cloudflare 记录
  async getCloudflareRecords() {
    try {
      if (this.config.debug) {
        console.log('正在获取 Cloudflare 记录...');
      }

      const response = await fetch(
        `${this.config.cloudflare.baseUrl}/zones/${this.config.cloudflare.zoneId}/dns_records?per_page=5000`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.cloudflare.apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new DNSSyncError(
          `Cloudflare API 错误: ${errorData.errors?.[0]?.message || response.statusText}`, 
          response.status,
          errorData
        );
      }

      const data = await response.json();
      
      if (this.config.debug) {
        console.log(`成功获取 ${data.result.length} 条 Cloudflare 记录`);
      }
      
      return data.result || [];
    } catch (error) {
      if (error instanceof DNSSyncError) throw error;
      throw new DNSSyncError(`获取 Cloudflare 记录失败: ${error.message}`, 500);
    }
  }

  // 获取 ClouDNS 记录
  async getClouDNSRecords() {
    try {
      if (this.config.debug) {
        console.log('正在获取 ClouDNS 记录...');
      }

      // 构建请求参数
      const params = new URLSearchParams();
      
      if (this.config.clouDNS.useSubAuth) {
        params.append('sub-auth-id', this.config.clouDNS.authId);
      } else {
        params.append('auth-id', this.config.clouDNS.authId);
      }
      
      params.append('auth-password', this.config.clouDNS.authPassword);
      params.append('domain-name', this.config.clouDNS.domainName);
      params.append('rows-per-page', '100'); // 获取更多记录

      const url = `${this.config.clouDNS.baseUrl}/records.json?${params.toString()}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new DNSSyncError(
          `ClouDNS API 错误: ${errorData.statusDescription || response.statusText}`, 
          response.status,
          errorData
        );
      }

      const data = await response.json();
      
      // 检查 API 错误
      if (data.status === 'Failed') {
        throw new DNSSyncError(`ClouDNS API 错误: ${data.statusDescription}`, 400, data);
      }
      
      // ClouDNS 返回的是对象而不是数组，需要转换
      const records = Array.isArray(data) ? data : Object.values(data || {});
      
      if (this.config.debug) {
        console.log(`成功获取 ${records.length} 条 ClouDNS 记录`);
      }
      
      return records;
    } catch (error) {
      if (error instanceof DNSSyncError) throw error;
      throw new DNSSyncError(`获取 ClouDNS 记录失败: ${error.message}`, 500);
    }
  }

  // 改进建议
  async withRetry(operation, maxRetries = this.config.maxRetries) {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        // 判断是否是临时错误
        if (error.code >= 500 || error.code === 429) {
          const delay = Math.min(
            this.config.retryDelay * Math.pow(2, attempt),
            30000 // 最大延迟30秒
          );
          
          console.warn(`操作失败，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`, error.message);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // 永久错误，立即失败
        throw error;
      }
    }
    
    throw lastError;
  }

  // 添加 ClouDNS 记录
  async addClouDNSRecord(record) {
    return this.withRetry(async () => {
      if (this.config.debug) {
        console.log(`正在添加 ClouDNS 记录: ${record.type} ${record.name}`);
      }

      // 构建请求参数
      const params = new URLSearchParams();
      
      if (this.config.clouDNS.useSubAuth) {
        params.append('sub-auth-id', this.config.clouDNS.authId);
      } else {
        params.append('auth-id', this.config.clouDNS.authId);
      }
      
      params.append('auth-password', this.config.clouDNS.authPassword);
      params.append('domain-name', this.config.clouDNS.domainName);
      params.append('record-type', record.type);
      params.append('host', this.formatHostname(record.name));
      params.append('record', record.content);
      params.append('ttl', record.ttl.toString());

      // 处理特殊记录类型的额外参数
      if (record.priority && (record.type === 'MX' || record.type === 'SRV')) {
        params.append('priority', record.priority.toString());
      }
      
      // SRV 记录特殊处理
      if (record.type === 'SRV') {
        if (record.data?.weight) params.append('weight', record.data.weight.toString());
        if (record.data?.port) params.append('port', record.data.port.toString());
      }
      
      // CAA 记录特殊处理
      if (record.type === 'CAA') {
        if (record.data?.flags !== undefined) params.append('flags', record.data.flags.toString());
        if (record.data?.tag) params.append('tag', record.data.tag);
      }

      const response = await fetch(`${this.config.clouDNS.baseUrl}/add-record.json`, {
        method: 'POST',
        body: params
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new DNSSyncError(
          `添加 ClouDNS 记录失败: ${errorData.statusDescription || response.statusText}`, 
          response.status,
          errorData
        );
      }

      const data = await response.json();
      if (data.status !== 'Success') {
        throw new DNSSyncError(`ClouDNS API 错误: ${data.statusDescription || '未知错误'}`, 400, data);
      }
      
      if (this.config.debug) {
        console.log(`成功添加 ClouDNS 记录: ${record.type} ${record.name}`);
      }
      
      return data;
    });
  }

  // 修改 ClouDNS 记录
  async updateClouDNSRecord(recordId, record) {
    try {
      if (this.config.debug) {
        console.log(`正在更新 ClouDNS 记录 ID ${recordId}: ${record.type} ${record.name}`);
      }

      // 构建请求参数
      const params = new URLSearchParams();
      
      if (this.config.clouDNS.useSubAuth) {
        params.append('sub-auth-id', this.config.clouDNS.authId);
      } else {
        params.append('auth-id', this.config.clouDNS.authId);
      }
      
      params.append('auth-password', this.config.clouDNS.authPassword);
      params.append('domain-name', this.config.clouDNS.domainName);
      params.append('record-id', recordId);
      params.append('host', this.formatHostname(record.name));
      params.append('record', record.content);
      params.append('ttl', record.ttl.toString());

      // 处理特殊记录类型的额外参数
      if (record.priority && (record.type === 'MX' || record.type === 'SRV')) {
        params.append('priority', record.priority.toString());
      }
      
      // SRV 记录特殊处理
      if (record.type === 'SRV') {
        if (record.data?.weight) params.append('weight', record.data.weight.toString());
        if (record.data?.port) params.append('port', record.data.port.toString());
      }
      
      // CAA 记录特殊处理
      if (record.type === 'CAA') {
        if (record.data?.flags !== undefined) params.append('flags', record.data.flags.toString());
        if (record.data?.tag) params.append('tag', record.data.tag);
      }

      const response = await fetch(`${this.config.clouDNS.baseUrl}/modify-record.json`, {
        method: 'POST',
        body: params
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new DNSSyncError(
          `更新 ClouDNS 记录失败: ${errorData.statusDescription || response.statusText}`, 
          response.status,
          errorData
        );
      }

      const data = await response.json();
      if (data.status !== 'Success') {
        throw new DNSSyncError(`ClouDNS API 错误: ${data.statusDescription || '未知错误'}`, 400, data);
      }
      
      if (this.config.debug) {
        console.log(`成功更新 ClouDNS 记录 ID ${recordId}`);
      }
      
      return data;
    } catch (error) {
      if (error instanceof DNSSyncError) throw error;
      throw new DNSSyncError(`更新 ClouDNS 记录失败: ${error.message}`, 500);
    }
  }

  // 删除 ClouDNS 记录
  async deleteClouDNSRecord(recordId) {
    try {
      if (this.config.debug) {
        console.log(`正在删除 ClouDNS 记录 ID ${recordId}`);
      }

      // 构建请求参数
      const params = new URLSearchParams();
      
      if (this.config.clouDNS.useSubAuth) {
        params.append('sub-auth-id', this.config.clouDNS.authId);
      } else {
        params.append('auth-id', this.config.clouDNS.authId);
      }
      
      params.append('auth-password', this.config.clouDNS.authPassword);
      params.append('domain-name', this.config.clouDNS.domainName);
      params.append('record-id', recordId);

      const response = await fetch(`${this.config.clouDNS.baseUrl}/delete-record.json`, {
        method: 'POST',
        body: params
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new DNSSyncError(
          `删除 ClouDNS 记录失败: ${errorData.statusDescription || response.statusText}`, 
          response.status,
          errorData
        );
      }

      const data = await response.json();
      if (data.status !== 'Success') {
        throw new DNSSyncError(`ClouDNS API 错误: ${data.statusDescription || '未知错误'}`, 400, data);
      }
      
      if (this.config.debug) {
        console.log(`成功删除 ClouDNS 记录 ID ${recordId}`);
      }
      
      return data;
    } catch (error) {
      if (error instanceof DNSSyncError) throw error;
      throw new DNSSyncError(`删除 ClouDNS 记录失败: ${error.message}`, 500);
    }
  }

  // 格式化主机名，处理根域名和子域名
  formatHostname(name) {
    const domainName = this.config.clouDNS.domainName;
    
    // 如果记录名称等于域名，则返回 @
    if (name === domainName) {
      return '@';
    }
    
    // 如果记录名称是子域名，则移除域名部分
    if (name.endsWith(`.${domainName}`)) {
      return name.slice(0, -(domainName.length + 1));
    }
    
    return name;
  }

  // 比较两条记录是否相同
  recordsEqual(cfRecord, cdRecord) {
    // 处理主机名格式差异
    const cfHost = this.formatHostname(cfRecord.name);
    const cdHost = cdRecord.host === '@' ? this.config.clouDNS.domainName : 
                  `${cdRecord.host}.${this.config.clouDNS.domainName}`;
    
    // 基本比较
    const basicMatch = 
      cfRecord.type === cdRecord.type &&
      cfRecord.content === cdRecord.record;
    
    // 主机名比较
    const hostMatch = cfHost === cdRecord.host || cfRecord.name === cdHost;
    
    // TTL 比较 (允许一定的误差)
    const ttlMatch = Math.abs(parseInt(cfRecord.ttl) - parseInt(cdRecord.ttl)) <= 60;
    
    // 特殊记录类型比较
    let specialFieldsMatch = true;
    
    // MX 记录比较优先级
    if (cfRecord.type === 'MX') {
      specialFieldsMatch = cfRecord.priority === parseInt(cdRecord.priority);
    }
    
    // SRV 记录比较
    if (cfRecord.type === 'SRV') {
      specialFieldsMatch = 
        cfRecord.priority === parseInt(cdRecord.priority) &&
        cfRecord.data?.weight === parseInt(cdRecord.weight) &&
        cfRecord.data?.port === parseInt(cdRecord.port);
    }
    
    // 返回比较结果
    return basicMatch && hostMatch && ttlMatch && specialFieldsMatch;
  }

  // 查找匹配的 ClouDNS 记录
  findMatchingClouDNSRecord(cfRecord, clouDNSRecords) {
    return clouDNSRecords.find(cdRecord => this.recordsEqual(cfRecord, cdRecord));
  }

  // 同步记录
  async syncRecords() {
    const startTime = Date.now();
    
    if (this.syncInProgress) {
      return {
        success: false,
        message: '同步已在进行中，请稍后再试'
      };
    }
    
    this.syncInProgress = true;
    
    try {
      if (this.config.debug) {
        console.log('开始同步 DNS 记录...');
      }
      
      const [cloudflareRecords, clouDNSRecords] = await Promise.all([
        this.getCloudflareRecords(),
        this.getClouDNSRecords()
      ]);

      if (this.config.debug) {
        console.log(`获取到 ${cloudflareRecords.length} 条 Cloudflare 记录和 ${clouDNSRecords.length} 条 ClouDNS 记录`);
      }

      // 根据同步模式执行不同的同步策略
      let syncResults = [];
      
      if (this.config.syncMode === 'full') {
        // 全量同步模式：删除所有 ClouDNS 记录，然后添加 Cloudflare 记录
        syncResults = await this.fullSync(cloudflareRecords, clouDNSRecords);
      } else {
        // 增量同步模式：只同步变化的记录
        syncResults = await this.incrementalSync(cloudflareRecords, clouDNSRecords);
      }

      this.lastSyncTime = new Date();
      
      // 记录同步历史
      const syncHistory = {
        timestamp: this.lastSyncTime.toISOString(),
        success: true,
        recordsProcessed: syncResults.length,
        details: syncResults
      };
      
      this.syncHistory.unshift(syncHistory);
      
      // 保留最近 10 条同步历史
      if (this.syncHistory.length > 10) {
        this.syncHistory = this.syncHistory.slice(0, 10);
      }
      
      // 发送通知
      if (this.config.enableNotifications && this.config.notificationWebhook) {
        await this.sendNotification({
          type: 'sync_complete',
          success: true,
          timestamp: this.lastSyncTime.toISOString(),
          recordsProcessed: syncResults.length,
          details: syncResults.slice(0, 5) // 只发送前 5 条记录详情
        });
      }
      
      const duration = Date.now() - startTime;
      await this.trackMetric('sync_duration', duration, { 
        success: true,
        recordCount: cloudflareRecords.length
      });
      
      return {
        success: true,
        syncedCount: syncResults.length,
        timestamp: this.lastSyncTime.toISOString(),
        details: syncResults
      };
    } catch (error) {
      // 记录同步失败历史
      const syncHistory = {
        timestamp: new Date().toISOString(),
        success: false,
        error: error.message
      };
      
      this.syncHistory.unshift(syncHistory);
      
      // 发送失败通知
      if (this.config.enableNotifications && this.config.notificationWebhook) {
        await this.sendNotification({
          type: 'sync_failed',
          success: false,
          timestamp: new Date().toISOString(),
          error: error.message
        }).catch(console.error); // 忽略通知发送失败
      }
      
      const duration = Date.now() - startTime;
      await this.trackMetric('sync_duration', duration, { 
        success: false,
        error: error.code
      });
      
      throw new DNSSyncError(
        `同步失败: ${error.message}`,
        error.code || 500,
        error.details
      );
    } finally {
      this.syncInProgress = false;
    }
  }

  // 全量同步
  async fullSync(cloudflareRecords, clouDNSRecords) {
    const results = [];
    
    // 1. 删除所有 ClouDNS 记录
    for (const cdRecord of clouDNSRecords) {
      try {
        await this.deleteClouDNSRecord(cdRecord.id);
        results.push({
          action: 'delete',
          record: cdRecord.host === '@' ? this.config.clouDNS.domainName : `${cdRecord.host}.${this.config.clouDNS.domainName}`,
          type: cdRecord.type,
          status: 'success'
        });
      } catch (error) {
        results.push({
          action: 'delete',
          record: cdRecord.host === '@' ? this.config.clouDNS.domainName : `${cdRecord.host}.${this.config.clouDNS.domainName}`,
          type: cdRecord.type,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    // 2. 添加所有 Cloudflare 记录
    for (const cfRecord of cloudflareRecords) {
      try {
        await this.addClouDNSRecord(cfRecord);
        results.push({
          action: 'add',
          record: cfRecord.name,
          type: cfRecord.type,
          status: 'success'
        });
      } catch (error) {
        results.push({
          action: 'add',
          record: cfRecord.name,
          type: cfRecord.type,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    return results;
  }

  // 增量同步
  async incrementalSync(cloudflareRecords, clouDNSRecords) {
    const results = [];
    
    // 1. 找出需要添加或更新的记录
    for (const cfRecord of cloudflareRecords) {
      const matchingRecord = this.findMatchingClouDNSRecord(cfRecord, clouDNSRecords);
      
      if (!matchingRecord) {
        // 需要添加的记录
        try {
          await this.addClouDNSRecord(cfRecord);
          results.push({
            action: 'add',
            record: cfRecord.name,
            type: cfRecord.type,
            status: 'success'
          });
        } catch (error) {
          results.push({
            action: 'add',
            record: cfRecord.name,
            type: cfRecord.type,
            status: 'failed',
            error: error.message
          });
        }
      } else if (this.needsUpdate(cfRecord, matchingRecord)) {
        // 需要更新的记录
        try {
          await this.updateClouDNSRecord(matchingRecord.id, cfRecord);
          results.push({
            action: 'update',
            record: cfRecord.name,
            type: cfRecord.type,
            status: 'success'
          });
        } catch (error) {
          results.push({
            action: 'update',
            record: cfRecord.name,
            type: cfRecord.type,
            status: 'failed',
            error: error.message
          });
        }
      }
    }
    
    // 2. 找出需要删除的记录（仅在双向同步模式下）
    if (this.config.syncDirection === 'bidirectional') {
      for (const cdRecord of clouDNSRecords) {
        const cdHost = cdRecord.host === '@' ? this.config.clouDNS.domainName : 
                      `${cdRecord.host}.${this.config.clouDNS.domainName}`;
        
        const matchingRecord = cloudflareRecords.find(cfRecord => 
          cfRecord.type === cdRecord.type && 
          (cfRecord.name === cdHost || this.formatHostname(cfRecord.name) === cdRecord.host)
        );
        
        if (!matchingRecord) {
          // 需要删除的记录
          try {
            await this.deleteClouDNSRecord(cdRecord.id);
            results.push({
              action: 'delete',
              record: cdHost,
              type: cdRecord.type,
              status: 'success'
            });
          } catch (error) {
            results.push({
              action: 'delete',
              record: cdHost,
              type: cdRecord.type,
              status: 'failed',
              error: error.message
            });
          }
        }
      }
    }
    
    return results;
  }

  // 检查记录是否需要更新
  needsUpdate(cfRecord, cdRecord) {
    // 检查内容是否不同
    if (cfRecord.content !== cdRecord.record) {
      return true;
    }
    
    // 检查 TTL 是否有显著差异
    if (Math.abs(parseInt(cfRecord.ttl) - parseInt(cdRecord.ttl)) > 60) {
      return true;
    }
    
    // 检查特殊字段
    if (cfRecord.type === 'MX' && cfRecord.priority !== parseInt(cdRecord.priority)) {
      return true;
    }
    
    if (cfRecord.type === 'SRV') {
      if (
        cfRecord.priority !== parseInt(cdRecord.priority) ||
        cfRecord.data?.weight !== parseInt(cdRecord.weight) ||
        cfRecord.data?.port !== parseInt(cdRecord.port)
      ) {
        return true;
      }
    }
    
    return false;
  }

  // 发送通知
  async sendNotification(data) {
    try {
      if (!this.config.notificationWebhook) {
        return;
      }
      
      await fetch(this.config.notificationWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });
    } catch (error) {
      console.error('发送通知失败:', error);
    }
  }

  // 检查是否需要同步
  shouldSync() {
    if (!this.lastSyncTime) return true;
    
    const now = new Date();
    const elapsedSeconds = (now - this.lastSyncTime) / 1000;
    return elapsedSeconds >= this.config.syncInterval;
  }

  // 获取同步状态
  getSyncStatus() {
    return {
      lastSync: this.lastSyncTime ? this.lastSyncTime.toISOString() : null,
      syncInProgress: this.syncInProgress,
      nextScheduledSync: this.lastSyncTime ? 
        new Date(this.lastSyncTime.getTime() + this.config.syncInterval * 1000).toISOString() :
        null,
      syncHistory: this.syncHistory,
      config: {
        syncInterval: this.config.syncInterval,
        syncDirection: this.config.syncDirection,
        syncMode: this.config.syncMode,
        enableNotifications: this.config.enableNotifications
      }
    };
  }
  
  // 获取配置信息
  getConfigInfo() {
    return {
      version: CONFIG.version,
      clouDNS: {
        domainName: this.config.clouDNS.domainName,
        useSubAuth: this.config.clouDNS.useSubAuth
      },
      cloudflare: {
        zoneId: this.config.cloudflare.zoneId
      },
      syncInterval: this.config.syncInterval,
      syncDirection: this.config.syncDirection,
      syncMode: this.config.syncMode,
      enableNotifications: this.config.enableNotifications,
      supportedRecordTypes: CONFIG.supportedRecordTypes
    };
  }

  // 改进建议
  async batchProcessRecords(records, processFn, batchSize = 10) {
    const results = [];
    const batches = [];
    
    // 分批
    for (let i = 0; i < records.length; i += batchSize) {
      batches.push(records.slice(i, i + batchSize));
    }
    
    // 处理每批
    for (const batch of batches) {
      const batchPromises = batch.map(record => 
        processFn(record).catch(error => ({ error, record }))
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }

  // 改进建议
  async getClouDNSRecordsWithCache(env) {
    // 尝试从缓存获取
    const cacheKey = `cloudns-records-${this.config.clouDNS.domainName}`;
    let records;
    
    try {
      const cached = await env.KV_CACHE.get(cacheKey, { type: 'json' });
      if (cached && cached.timestamp > Date.now() - 300000) { // 5分钟缓存
        return cached.data;
      }
    } catch (e) {
      console.warn('缓存读取失败:', e);
    }
    
    // 缓存未命中，从 API 获取
    records = await this.getClouDNSRecords();
    
    // 存入缓存
    try {
      await env.KV_CACHE.put(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        data: records
      }), { expirationTtl: 3600 }); // 1小时过期
    } catch (e) {
      console.warn('缓存写入失败:', e);
    }
    
    return records;
  }

  // 改进建议
  async syncWithTransaction(operations) {
    const journal = [];
    
    try {
      for (const op of operations) {
        const result = await op.execute();
        journal.push({ op, result, success: true });
      }
      return journal;
    } catch (error) {
      // 回滚已完成的操作
      for (let i = journal.length - 1; i >= 0; i--) {
        const entry = journal[i];
        if (entry.success && entry.op.rollback) {
          try {
            await entry.op.rollback(entry.result);
          } catch (rollbackError) {
            console.error('回滚失败:', rollbackError);
          }
        }
      }
      throw error;
    }
  }

  // 改进建议
  async bidirectionalSync(cloudflareRecords, clouDNSRecords) {
    // 现有同步逻辑...
    
    // 添加冲突检测
    const conflicts = [];
    
    for (const cfRecord of cloudflareRecords) {
      const cdRecord = this.findMatchingClouDNSRecord(cfRecord, clouDNSRecords);
      
      if (cdRecord && !this.recordsEqual(cfRecord, cdRecord)) {
        conflicts.push({
          cloudflare: cfRecord,
          cloudns: cdRecord,
          differences: this.getRecordDifferences(cfRecord, cdRecord)
        });
      }
    }
    
    // 根据策略解决冲突
    if (conflicts.length > 0) {
      await this.resolveConflicts(conflicts);
    }
  }

  getRecordDifferences(cfRecord, cdRecord) {
    const differences = {};
    
    if (cfRecord.content !== cdRecord.record) {
      differences.content = {
        cloudflare: cfRecord.content,
        cloudns: cdRecord.record
      };
    }
    
    // 检查其他字段...
    
    return differences;
  }

  async resolveConflicts(conflicts) {
    const strategy = this.config.conflictStrategy || 'cloudflare-wins';
    
    switch (strategy) {
      case 'cloudflare-wins':
        // 以 Cloudflare 为准
        for (const conflict of conflicts) {
          await this.updateClouDNSRecord(conflict.cloudns.id, conflict.cloudflare);
        }
        break;
      case 'cloudns-wins':
        // 以 ClouDNS 为准
        // 实现 Cloudflare 更新逻辑
        break;
      case 'newer-wins':
        // 根据修改时间决定
        // 需要获取记录的修改时间
        break;
    }
  }

  // 改进建议
  async trackMetric(name, value, tags = {}) {
    try {
      // 记录自定义指标
      const metrics = {
        name,
        value,
        timestamp: Date.now(),
        tags
      };
      
      // 存储到 KV 或发送到监控系统
      await this.env.KV_METRICS.put(
        `metric-${name}-${Date.now()}`,
        JSON.stringify(metrics),
        { expirationTtl: 86400 * 7 } // 保留7天
      );
    } catch (e) {
      console.warn('指标记录失败:', e);
    }
  }
}

// HTML 界面生成器
class HTMLGenerator {
  static generateDashboard(syncStatus, configInfo, language = 'en-US') {
    const t = translations[language] || translations['en-US'];
    
    return `
    <!DOCTYPE html>
    <html lang="${language}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CloudSync DNS - 控制面板</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css">
      <style>
        body { padding-top: 20px; }
        .card { margin-bottom: 20px; }
        .status-badge { font-size: 0.9em; }
        .success { color: #198754; }
        .failed { color: #dc3545; }
        .sync-history { max-height: 400px; overflow-y: auto; }
      </style>
    </head>
    <body>
      <div class="container">
        <header class="d-flex justify-content-between align-items-center mb-4">
          <h1>CloudSync DNS</h1>
          <span class="badge bg-primary">v${configInfo.version}</span>
        </header>
        
        <div class="row">
          <div class="col-md-6">
            <div class="card">
              <div class="card-header">
                <h5 class="card-title mb-0">${t.syncStatus}</h5>
              </div>
              <div class="card-body">
                <div class="d-flex justify-content-between mb-3">
                  <span>${t.lastSync}:</span>
                  <span>${syncStatus.lastSync ? new Date(syncStatus.lastSync).toLocaleString() : '从未同步'}</span>
                </div>
                <div class="d-flex justify-content-between mb-3">
                  <span>下次计划同步:</span>
                  <span>${syncStatus.nextScheduledSync ? new Date(syncStatus.nextScheduledSync).toLocaleString() : '未计划'}</span>
                </div>
                <div class="d-grid gap-2">
                  <button id="syncNowBtn" class="btn btn-primary" ${syncStatus.syncInProgress ? 'disabled' : ''}>
                    ${t.syncNowBtn}
                  </button>
                </div>
              </div>
            </div>
            
            <div class="card">
              <div class="card-header">
                <h5 class="card-title mb-0">配置信息</h5>
              </div>
              <div class="card-body">
                <div class="d-flex justify-content-between mb-2">
                  <span>ClouDNS 域名:</span>
                  <span>${configInfo.clouDNS.domainName}</span>
                </div>
                <div class="d-flex justify-content-between mb-2">
                  <span>Cloudflare Zone ID:</span>
                  <span>${configInfo.cloudflare.zoneId}</span>
                </div>
                <div class="d-flex justify-content-between mb-2">
                  <span>同步间隔:</span>
                  <span>${configInfo.syncInterval} 秒</span>
                </div>
                <div class="d-flex justify-content-between mb-2">
                  <span>同步方向:</span>
                  <span>${configInfo.syncDirection === 'cloudflare-to-cloudns' ? 'Cloudflare → ClouDNS' : 
                          configInfo.syncDirection === 'cloudns-to-cloudflare' ? 'ClouDNS → Cloudflare' : '双向'}</span>
                </div>
                <div class="d-flex justify-content-between mb-2">
                  <span>同步模式:</span>
                  <span>${configInfo.syncMode === 'incremental' ? '增量同步' : '全量同步'}</span>
                </div>
                <div class="d-flex justify-content-between mb-2">
                  <span>通知:</span>
                  <span>${configInfo.enableNotifications ? '已启用' : '已禁用'}</span>
                </div>
              </div>
            </div>
          </div>
          
          <div class="col-md-6">
            <div class="card">
              <div class="card-header">
                <h5 class="card-title mb-0">同步历史</h5>
              </div>
              <div class="card-body sync-history">
                ${syncStatus.syncHistory.length > 0 ? 
                  syncStatus.syncHistory.map(history => `
                    <div class="card mb-3">
                      <div class="card-body">
                        <div class="d-flex justify-content-between">
                          <span>${new Date(history.timestamp).toLocaleString()}</span>
                          <span class="badge ${history.success ? 'bg-success' : 'bg-danger'}">
                            ${history.success ? '成功' : '失败'}
                          </span>
                        </div>
                        ${history.success ? 
                          `<p class="mb-1 mt-2">处理记录数: ${history.recordsProcessed}</p>
                           <div class="mt-2">
                             ${history.details.slice(0, 5).map(detail => `
                               <div class="d-flex justify-content-between small">
                                 <span>${detail.action} ${detail.type} ${detail.record}</span>
                                 <span class="status-badge ${detail.status === 'success' ? 'success' : 'failed'}">
                                   ${detail.status === 'success' ? '成功' : '失败'}
                                 </span>
                               </div>
                             `).join('')}
                             ${history.details.length > 5 ? `<div class="text-center small mt-1">还有 ${history.details.length - 5} 条记录...</div>` : ''}
                           </div>` : 
                          `<p class="text-danger mb-0 mt-2">错误: ${history.error}</p>`
                        }
                      </div>
                    </div>
                  `).join('') : 
                  '<div class="text-center text-muted">暂无同步历史</div>'
                }
              </div>
            </div>
          </div>
        </div>
        
        <div class="row mt-3">
          <div class="col-12">
            <div class="card">
              <div class="card-header">
                <h5 class="card-title mb-0">快速操作</h5>
              </div>
              <div class="card-body">
                <div class="row">
                  <div class="col-md-4 mb-2">
                    <a href="/cloudflare-records" class="btn btn-outline-primary w-100">查看 Cloudflare 记录</a>
                  </div>
                  <div class="col-md-4 mb-2">
                    <a href="/cloudns-records" class="btn btn-outline-primary w-100">查看 ClouDNS 记录</a>
                  </div>
                  <div class="col-md-4 mb-2">
                    <a href="/health" class="btn btn-outline-secondary w-100">健康检查</a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <footer class="mt-4 mb-4 text-center text-muted">
          <small>CloudSync DNS - Cloudflare 与 ClouDNS 同步工具</small>
        </footer>
      </div>
      
      <script>
        document.getElementById('syncNowBtn').addEventListener('click', async () => {
          try {
            document.getElementById('syncNowBtn').disabled = true;
            document.getElementById('syncNowBtn').textContent = '同步中...';
            
            const response = await fetch('/sync', {
              method: 'POST'
            });
            
            if (!response.ok) {
              throw new Error('同步请求失败');
            }
            
            const result = await response.json();
            alert('同步成功完成！处理了 ' + result.syncedCount + ' 条记录。');
            location.reload();
          } catch (error) {
            alert('同步失败: ' + error.message);
            document.getElementById('syncNowBtn').disabled = false;
            document.getElementById('syncNowBtn').textContent = '立即同步';
          }
        });
      </script>
    </body>
    </html>
    `;
  }
  
  static generateRecordsList(title, records) {
    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - CloudSync DNS</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css">
      <style>
        body { padding-top: 20px; }
        .card { margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <header class="d-flex justify-content-between align-items-center mb-4">
          <h1>${title}</h1>
          <a href="/" class="btn btn-outline-primary">返回控制面板</a>
        </header>
        
        <div class="card">
          <div class="card-header">
            <div class="d-flex justify-content-between align-items-center">
              <h5 class="mb-0">记录列表</h5>
              <span class="badge bg-primary">${records.length} 条记录</span>
            </div>
          </div>
          <div class="card-body">
            <div class="table-responsive">
              <table class="table table-striped table-hover">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>名称</th>
                    <th>内容</th>
                    <th>TTL</th>
                    <th>其他</th>
                  </tr>
                </thead>
                <tbody>
                  ${records.map(record => `
                    <tr>
                      <td><span class="badge bg-secondary">${record.type || record.record_type}</span></td>
                      <td>${record.name || record.host}</td>
                      <td class="text-truncate" style="max-width: 300px;">${record.content || record.record}</td>
                      <td>${record.ttl}</td>
                      <td>
                        ${record.priority ? `优先级: ${record.priority}<br>` : ''}
                        ${record.data?.weight ? `权重: ${record.data.weight}<br>` : ''}
                        ${record.data?.port ? `端口: ${record.data.port}<br>` : ''}
                        ${record.data?.flags !== undefined ? `标志: ${record.data.flags}<br>` : ''}
                        ${record.data?.tag ? `标签: ${record.data.tag}` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        
        <footer class="mt-4 mb-4 text-center text-muted">
          <small>CloudSync DNS - Cloudflare 与 ClouDNS 同步工具</small>
        </footer>
      </div>
    </body>
    </html>
    `;
  }
  
  static generateHealthCheck(health) {
    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>健康检查 - CloudSync DNS</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css">
      <style>
        body { padding-top: 20px; }
        .card { margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <header class="d-flex justify-content-between align-items-center mb-4">
          <h1>健康检查</h1>
          <a href="/" class="btn btn-outline-primary">返回控制面板</a>
        </header>
        
        <div class="card">
          <div class="card-header">
            <h5 class="card-title mb-0">系统状态</h5>
          </div>
          <div class="card-body">
            <div class="d-flex justify-content-between mb-3">
              <span>状态:</span>
              <span class="badge bg-success">正常</span>
            </div>
            <div class="d-flex justify-content-between mb-3">
              <span>版本:</span>
              <span>${health.version}</span>
            </div>
            <div class="d-flex justify-content-between mb-3">
              <span>上次同步:</span>
              <span>${health.lastSync ? new Date(health.lastSync).toLocaleString() : '从未同步'}</span>
            </div>
            <div class="d-flex justify-content-between mb-3">
              <span>内存使用:</span>
              <span>${health.memoryUsage ? Math.round(health.memoryUsage / 1024 / 1024 * 100) / 100 + ' MB' : '未知'}</span>
            </div>
            <div class="d-flex justify-content-between mb-3">
              <span>运行时间:</span>
              <span>${health.uptime ? Math.floor(health.uptime / 86400) + '天 ' + Math.floor((health.uptime % 86400) / 3600) + '小时 ' + Math.floor((health.uptime % 3600) / 60) + '分钟' : '未知'}</span>
            </div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-header">
            <h5 class="card-title mb-0">API 连接测试</h5>
          </div>
          <div class="card-body">
            <div class="d-flex justify-content-between mb-3">
              <span>Cloudflare API:</span>
              <span class="badge ${health.cloudflareApiStatus === 'ok' ? 'bg-success' : 'bg-danger'}">
                ${health.cloudflareApiStatus === 'ok' ? '正常' : '异常'}
              </span>
            </div>
            <div class="d-flex justify-content-between mb-3">
              <span>ClouDNS API:</span>
              <span class="badge ${health.clouDNSApiStatus === 'ok' ? 'bg-success' : 'bg-danger'}">
                ${health.clouDNSApiStatus === 'ok' ? '正常' : '异常'}
              </span>
            </div>
            ${health.cloudflareApiStatus !== 'ok' ? `<div class="alert alert-danger mt-3">Cloudflare API 错误: ${health.cloudflareApiError}</div>` : ''}
            ${health.clouDNSApiStatus !== 'ok' ? `<div class="alert alert-danger mt-3">ClouDNS API 错误: ${health.clouDNSApiError}</div>` : ''}
          </div>
        </div>
        
        <footer class="mt-4 mb-4 text-center text-muted">
          <small>CloudSync DNS - Cloudflare 与 ClouDNS 同步工具</small>
        </footer>
      </div>
    </body>
    </html>
    `;
  }
}

// 添加翻译支持
const translations = {
  'en-US': {
    syncStatus: 'Synchronization Status',
    lastSync: 'Last Sync',
    syncNowBtn: 'Sync Now'
  },
  'zh-CN': {
    syncStatus: '同步状态',
    lastSync: '上次同步',
    syncNowBtn: '立即同步'
  }
};

// 检测语言
function detectLanguage(request) {
  const acceptLanguage = request.headers.get('Accept-Language') || '';
  if (acceptLanguage.includes('zh')) {
    return 'zh-CN';
  }
  return 'en-US';
}

// Worker 入口点
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dnsSync = new DNSSync(env);
    
    // 处理静态资源请求
    if (url.pathname === '/favicon.ico') {
      return new Response('Not Found', { status: 404 });
    }
    
    // 处理 Web 界面请求
    if (url.pathname === '/' && request.method === 'GET') {
      const syncStatus = dnsSync.getSyncStatus();
      const configInfo = dnsSync.getConfigInfo();
      const language = detectLanguage(request);
      const html = HTMLGenerator.generateDashboard(syncStatus, configInfo, language);
      
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    // 健康检查端点
    if (url.pathname === '/health') {
      try {
        // 测试 API 连接
        let cloudflareApiStatus = 'ok';
        let clouDNSApiStatus = 'ok';
        let cloudflareApiError = null;
        let clouDNSApiError = null;
        
        try {
          await fetch(
            `${dnsSync.config.cloudflare.baseUrl}/zones/${dnsSync.config.cloudflare.zoneId}`,
            {
              headers: {
                'Authorization': `Bearer ${dnsSync.config.cloudflare.apiToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
        } catch (error) {
          cloudflareApiStatus = 'error';
          cloudflareApiError = error.message;
        }
        
        try {
          const params = new URLSearchParams();
          
          if (dnsSync.config.clouDNS.useSubAuth) {
            params.append('sub-auth-id', dnsSync.config.clouDNS.authId);
          } else {
            params.append('auth-id', dnsSync.config.clouDNS.authId);
          }
          
          params.append('auth-password', dnsSync.config.clouDNS.authPassword);
          
          await fetch(`${dnsSync.config.clouDNS.baseUrl}/get-available-ttl.json?${params.toString()}`);
        } catch (error) {
          clouDNSApiStatus = 'error';
          clouDNSApiError = error.message;
        }
        
        const health = {
          status: 'ok',
          version: CONFIG.version,
          lastSync: dnsSync.lastSyncTime ? dnsSync.lastSyncTime.toISOString() : null,
          uptime: process.uptime ? process.uptime() : null,
          memoryUsage: process.memoryUsage ? process.memoryUsage().heapUsed : null,
          cloudflareApiStatus,
          clouDNSApiStatus,
          cloudflareApiError,
          clouDNSApiError
        };
        
        // 根据请求类型返回 HTML 或 JSON
        const acceptHeader = request.headers.get('Accept') || '';
        if (acceptHeader.includes('text/html')) {
          const html = HTMLGenerator.generateHealthCheck(health);
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        } else {
          return new Response(JSON.stringify(health), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'error',
          error: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 强制同步端点
    if (url.pathname === '/sync' && request.method === 'POST') {
      try {
        const result = await dnsSync.syncRecords();
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error.message,
          code: error.code || 500,
          details: error.details || {}
        }), {
          status: error.code || 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 获取 Cloudflare 记录端点
    if (url.pathname === '/cloudflare-records') {
      try {
        const records = await dnsSync.getCloudflareRecords();
        
        // 根据请求类型返回 HTML 或 JSON
        const acceptHeader = request.headers.get('Accept') || '';
        if (acceptHeader.includes('text/html')) {
          const html = HTMLGenerator.generateRecordsList('Cloudflare DNS 记录', records);
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        } else {
          return new Response(JSON.stringify(records), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({
          error: error.message,
          code: error.code || 500
        }), {
          status: error.code || 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 获取 ClouDNS 记录端点
    if (url.pathname === '/cloudns-records') {
      try {
        const records = await dnsSync.getClouDNSRecords();
        
        // 根据请求类型返回 HTML 或 JSON
        const acceptHeader = request.headers.get('Accept') || '';
        if (acceptHeader.includes('text/html')) {
          const html = HTMLGenerator.generateRecordsList('ClouDNS 记录', records);
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        } else {
          return new Response(JSON.stringify(records), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({
          error: error.message,
          code: error.code || 500
        }), {
          status: error.code || 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 默认路由 - 检查是否需要同步
    if (url.pathname === '/auto-sync') {
      try {
        let result;
        if (dnsSync.shouldSync()) {
          result = await dnsSync.syncRecords();
        } else {
          result = {
            status: 'skipped',
            message: '同步间隔未到，跳过同步',
            lastSync: dnsSync.lastSyncTime.toISOString(),
            nextSync: new Date(dnsSync.lastSyncTime.getTime() + dnsSync.config.syncInterval * 1000).toISOString()
          };
        }
        
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error.message,
          code: error.code || 500
        }), {
          status: error.code || 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 在 Worker 中实现 SSE 端点
    if (url.pathname === '/sync-progress') {
      const syncProgress = new SyncProgress();
      
      // 设置 SSE 响应头
      const headers = new Headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      
      // 添加进度监听器
      syncProgress.addListener(progress => {
        writer.write(new TextEncoder().encode(`data: ${JSON.stringify(progress)}\n\n`));
      });
      
      // 启动同步
      ctx.waitUntil((async () => {
        try {
          await dnsSync.syncRecordsWithProgress(syncProgress);
        } catch (error) {
          syncProgress.fail(error);
        } finally {
          writer.close();
        }
      })());
      
      return new Response(stream.readable, { headers });
    }
    
    // 404 - 未找到路由
    return new Response('Not Found', { status: 404 });
  },
  
  // 添加定时触发器支持
  async scheduled(event, env, ctx) {
    const dnsSync = new DNSSync(env);
    try {
      return await dnsSync.syncRecords();
    } catch (error) {
      console.error('定时同步失败:', error);
      return { error: error.message };
    }
  }
};