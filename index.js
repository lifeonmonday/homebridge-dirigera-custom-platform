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
    this.lastButtonStates = {}; // Pamięć podręczna do śledzenia zmian stanu przycisków

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

    // 1. CZUJNIK OBECNOŚCI (np. Sonoff SNZB-06P)
    if (device.deviceType === 'occupancySensor') {
      this.setupOccupancySensor(device, uuid, existingAccessory);
    }
    // 2. CZUJNIK NATĘŻENIA ŚWIATŁA
    else if (device.deviceType === 'lightSensor' || device.attributes?.illuminance !== undefined) {
      this.setupLightSensor(device, uuid, existingAccessory);
    }
    // 3. PILOT / KONTROLER (np. IKEA RODRET) -> Programowalny Przycisk HomeKit
    else if (device.type === 'controller' || device.deviceType === 'lightController') {
      this.setupButtonController(device, uuid, existingAccessory);
    }
    // 4. ŻARÓWKA / ŚCIEMNIACZ (Żarówki Sonoff / IKEA)
    else if (device.type === 'light' || device.attributes?.isOn !== undefined) {
      this.setupLightbulb(device, uuid, existingAccessory);
    }
    // 5. TERMOSTAT / CZUJNIK TEMPERATURY
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

  setupLightSensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Swiatla';
    const lux = Math.max(device.attributes?.illuminance || 0.0001, 0.0001);
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie czujnika światła: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.addService(Service.LightSensor, name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const service = accessory.getService(Service.LightSensor);
    service.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, lux);
  }

  setupButtonController(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Pilot RODRET';
    const battery = device.attributes?.batteryPercentage;
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie pilota/przycisku: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      
      // Tworzymy serwis programowalnego przycisku
      const btnService = accessory.addService(Service.StatelessProgrammableSwitch, name);
      btnService.getCharacteristic(Characteristic.ServiceLabelIndex).setValue(1);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Obsługa poziomu baterii pilota RODRET
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

    // Wykrywanie kliknięcia przycisku na podstawie zmiany stanu w API
    const currentState = JSON.stringify({ isOn: device.attributes?.isOn, lightLevel: device.attributes?.lightLevel });
    const previousState = this.lastButtonStates[device.id];

    if (previousState && previousState !== currentState) {
      this.log.info(`Wykryto naciśnięcie przycisku na pilocie ${name}!`);
      const btnService = accessory.getService(Service.StatelessProgrammableSwitch);
      // Wysyła zdarzenie pojedynczego kliknięcia do Apple Home
      btnService.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }

    this.lastButtonStates[device.id] = currentState;
  }

  setupLightbulb(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Światło Dirigera';
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie żarówki: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      const lightService = accessory.addService(Service.Lightbulb, name);

      lightService.getCharacteristic(Characteristic.On)
        .onSet((value) => this.sendDeviceCommand(device.id, [{ attributes: { isOn: value } }]));

      if (device.attributes?.lightLevel !== undefined) {
        lightService.getCharacteristic(Characteristic.Brightness)
          .onSet((value) => this.sendDeviceCommand(device.id, [{ attributes: { lightLevel: value } }]));
      }

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const lightService = accessory.getService(Service.Lightbulb);

    if (device.attributes?.isOn !== undefined) {
      lightService.updateCharacteristic(Characteristic.On, device.attributes.isOn);
    }

    if (device.attributes?.lightLevel !== undefined) {
      lightService.updateCharacteristic(Characteristic.Brightness, device.attributes.lightLevel);
    }
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
      
      const thermostatService = accessory.addService(Service.Thermostat, name);
      
      thermostatService.setCharacteristic(Characteristic.TargetTemperature, 21);
      thermostatService.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
      thermostatService.setCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const thermostatService = accessory.getService(Service.Thermostat);
    thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, temp);

    if (humidity !== undefined) {
      thermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }

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

  sendDeviceCommand(deviceId, patchData) {
    const payload = JSON.stringify(patchData);
    const options = {
      hostname: this.host,
      port: 8443,
      path: `/v1/devices/${deviceId}`,
      method: 'PATCH',
      rejectUnauthorized: false,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        this.log.debug(`Pomyślnie wysłano komendę do urządzenia ${deviceId}`);
      } else {
        this.log.error(`Błąd sterowania urządzeniem ${deviceId}: HTTP ${res.statusCode}`);
      }
    });

    req.on('error', (err) => {
      this.log.error(`Błąd zapytania PATCH do Dirigery: ${err.message}`);
    });

    req.write(payload);
    req.end();
  }
}
