const https = require('https');

const PLUGIN_NAME = 'homebridge-dirigera-custom-platform';
const PLATFORM_NAME = 'DirigeraCustomPlatform';

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, DirigeraCustomPlatform);
};

class DirigeraCustomPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.host = this.config.host;
    this.token = this.config.token;
    this.pollInterval = (this.config.pollInterval || 5) * 1000;

    this.accessories = [];

    if (!this.host || !this.token) {
      this.log.error('Brak hosta lub tokena Dirigery w konfiguracji!');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.fetchAndProcessDevices();
      setInterval(() => this.fetchAndProcessDevices(), this.pollInterval);
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  fetchAndProcessDevices() {
    const options = {
      hostname: this.host,
      port: 8443,
      path: '/v1/devices',
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          this.log.error(`Błąd API Dirigery: HTTP ${res.statusCode}`);
          return;
        }

        try {
          const devices = JSON.parse(data);
          for (const device of devices) {
            this.handleDevice(device);
          }
        } catch (err) {
          this.log.error(`Błąd przetwarzania danych: ${err.message}`);
        }
      });
    });

    req.on('error', (err) => {
      this.log.error(`Błąd połączenia z Dirigera: ${err.message}`);
    });

    req.end();
  }

  handleDevice(device) {
    const uuid = this.api.hap.uuid.generate(device.id);
    const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

    const deviceType = (device.deviceType || '').toLowerCase();
    const type = (device.type || '').toLowerCase();

    // 1. TERMOSTAT (Czujnik temperatury)
    if (device.attributes?.currentTemperature !== undefined) {
      this.setupThermostat(device, uuid, existingAccessory);
    }
    // 2. CZUJNIK OBECNOŚCI / RUCHU
    else if (
      deviceType.includes('occupancy') || 
      deviceType.includes('motion') || 
      type.includes('motion') || 
      device.attributes?.isDetected !== undefined || 
      device.attributes?.isMotionDetected !== undefined
    ) {
      this.setupOccupancySensor(device, uuid, existingAccessory);
    }
  }

  // Pomocnicza metoda bezpiecznego pobierania/tworzenia usługi
  getOrCreateService(accessory, serviceType, name) {
    let service = accessory.getService(serviceType);
    if (!service) {
      service = accessory.addService(serviceType, name);
    }
    return service;
  }

  // Uzupełnianie informacji o urządzeniu (Manufacturer, Model, Serial Number, Firmware)
  updateAccessoryInformation(accessory, device) {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;
    const infoService = accessory.getService(Service.AccessoryInformation);

    if (infoService) {
      const manufacturer = device.attributes?.manufacturer || 'IKEA / Sonoff';
      const model = device.attributes?.model || device.deviceType || 'Unknown Model';
      const serialNumber = device.attributes?.serialNumber || device.id || 'Unknown SN';
      const firmwareVersion = device.attributes?.firmwareVersion || '1.0.0';

      infoService
        .setCharacteristic(Characteristic.Manufacturer, manufacturer)
        .setCharacteristic(Characteristic.Model, model)
        .setCharacteristic(Characteristic.SerialNumber, serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, firmwareVersion);
    }
  }

  // --- 1. TERMOSTAT ---
  setupThermostat(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Termostat';
    const temp = device.attributes?.currentTemperature || 20;
    const humidity = device.attributes?.currentRH;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie Nowego Termostatu: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      
      const thermostatService = accessory.addService(Service.Thermostat, name);
      
      // Domyślne wartości dla sztucznego termostatu
      thermostatService.setCharacteristic(Characteristic.TargetTemperature, 21);
      thermostatService.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
      thermostatService.setCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Uaktualnij metadane urządzenia
    this.updateAccessoryInformation(accessory, device);

    const thermostatService = this.getOrCreateService(accessory, Service.Thermostat, name);
    thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, temp);

    if (humidity !== undefined) {
      thermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }

    if (device.attributes?.batteryPercentage !== undefined) {
      this.updateBattery(accessory, name, device.attributes.batteryPercentage);
    }
  }

  // --- 2. CZUJNIK OBECNOŚCI ---
  setupOccupancySensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Obecnosci';
    const isDetected = device.attributes?.isDetected ?? device.attributes?.isMotionDetected ?? false;
    
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie Czujnika Obecności: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Uaktualnij metadane urządzenia
    this.updateAccessoryInformation(accessory, device);

    const service = this.getOrCreateService(accessory, Service.OccupancySensor, name);
    const state = isDetected 
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED 
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;

    service.updateCharacteristic(Characteristic.OccupancyDetected, state);

    if (device.attributes?.batteryPercentage !== undefined) {
      this.updateBattery(accessory, name, device.attributes.batteryPercentage);
    }
  }

  // --- BATERIA ---
  updateBattery(accessory, name, level) {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    const batteryService = this.getOrCreateService(accessory, Service.Battery, `${name} Bateria`);
    batteryService.updateCharacteristic(Characteristic.BatteryLevel, level);
    batteryService.updateCharacteristic(
      Characteristic.StatusLowBattery, 
      level < 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
    );
  }
}
