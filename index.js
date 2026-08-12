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
    this.pollInterval = (this.config.pollInterval || 10) * 1000;

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

  // Wymagane przez Dynamic Platform do odzyskania zapisanych akcesoriów z cache
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
          this.log.error(`Błąd parsowania JSON: ${err.message}`);
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

    // 1. CZUJNIK OBECNOŚCI (deviceType: occupancySensor / isDetected)
    if (device.deviceType === 'occupancySensor' || device.attributes?.isDetected !== undefined) {
      this.setupOccupancySensor(device, uuid, existingAccessory);
    }
    // 2. THERMOSTAT / CZUJNIK TEMPERATURY (attributes.currentTemperature)
    else if (device.attributes?.currentTemperature !== undefined) {
      this.setupThermostat(device, uuid, existingAccessory);
    }
  }

  setupOccupancySensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Obecnosci';
    const isDetected = device.attributes?.isDetected || false;
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie nowego czujnika obecności: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.addService(Service.OccupancySensor, name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const service = accessory.getService(Service.OccupancySensor);
    const state = isDetected 
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED 
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;

    service.updateCharacteristic(Characteristic.OccupancyDetected, state);
  }

  setupThermostat(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Termostat Sonoff';
    const temp = device.attributes?.currentTemperature || 20;
    const humidity = device.attributes?.currentRH;
    const battery = device.attributes?.batteryPercentage;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie nowego termostatu: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      
      // Główny serwis: Thermostat
      const thermostatService = accessory.addService(Service.Thermostat, name);
      
      // Domyślne statyczne stany dla wirtualnego termostatu (OFF/HEATING)
      thermostatService.setCharacteristic(Characteristic.TargetTemperature, 21);
      thermostatService.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
      thermostatService.setCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const thermostatService = accessory.getService(Service.Thermostat);

    // Aktualizacja aktualnej temperatury
    thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, temp);

    // Dodanie/aktualizacja wilgotności (jeśli urządzenie ją raportuje)
    if (humidity !== undefined) {
      thermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }

    // Dodanie/aktualizacja poziomu baterii
    if (battery !== undefined) {
      let batteryService = accessory.getService(Service.Battery);
      if (!batteryService) {
        batteryService = accessory.addService(Service.Battery, `${name} Bateria`);
      }
      batteryService.updateCharacteristic(Characteristic.BatteryLevel, battery);
      batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery, 
        battery < 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }
}
