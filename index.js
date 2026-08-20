const https = require('https');
const WebSocket = require('ws');

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
    this.ws = null;

    if (!this.host || !this.token) {
      this.log.error('Brak hosta lub tokena Dirigery w konfiguracji!');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      // Periodic fetch for stateful devices (Thermostat, Occupancy Sensor)
      this.fetchAndProcessDevices();
      setInterval(() => this.fetchAndProcessDevices(), this.pollInterval);

      // WebSocket connection for real-time button events
      this.initWebSocket();
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  // --- WEBSOCKET FOR REAL-TIME BUTTON EVENTS ---
  initWebSocket() {
    const wsUrl = `wss://${this.host}:8443/v1/subscribe`;

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      rejectUnauthorized: false
    });

    this.ws.on('open', () => {
      this.log.info('Połączono ze strumieniem zdarzeń WebSocket Dirigery!');
    });

    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data);

        // Capture button events from remotes
        if (event.type === 'remotePressEvent' && event.data?.id) {
          this.handleRemotePress(event.data.id, event.data.clickPattern);
        }
      } catch (err) {
        this.log.error(`Błąd dekodowania zdarzenia WS: ${err.message}`);
      }
    });

    this.ws.on('error', (err) => {
      this.log.error(`Błąd połączenia WebSocket: ${err.message}`);
    });

    this.ws.on('close', () => {
      this.log.warn('WebSocket zamknięty. Ponowne łączenie za 5s...');
      setTimeout(() => this.initWebSocket(), 5000);
    });
  }

  handleRemotePress(deviceId, clickPattern) {
    const uuid = this.api.hap.uuid.generate(deviceId);
    const accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (!accessory) return;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;
    const buttonService = accessory.getService(Service.StatelessProgrammableSwitch);

    if (!buttonService) return;

    let eventValue;
    if (clickPattern === 'singlePress') {
      eventValue = Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
    } else if (clickPattern === 'doublePress') {
      eventValue = Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS;
    } else if (clickPattern === 'longPress') {
      eventValue = Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
    }

    if (eventValue !== undefined) {
      this.log.info(`Pilot ${accessory.displayName}: ${clickPattern}`);
      buttonService.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, eventValue);
    }
  }

  // --- HTTP REST API FETCHING ---
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
    const deviceType = device.deviceType;

    // 1. TERMOSTAT (Z czujnika temperatury)
    if (device.attributes?.currentTemperature !== undefined) {
      this.setupThermostat(device, uuid, existingAccessory);
    }
    // 2. CZUJNIK OBECNOŚCI
    else if (deviceType === 'occupancySensor') {
      this.setupOccupancySensor(device, uuid, existingAccessory);
    }
    // 3. PILOT DŹWIĘKOWY / SOUND CONTROLLER (jako Przycisk HomeKit)
    else if (deviceType === 'soundController') {
      this.setupSoundController(device, uuid, existingAccessory);
    }
  }

  getOrCreateService(accessory, serviceType, name) {
    let service = accessory.getService(serviceType);
    if (!service) {
      service = accessory.addService(serviceType, name);
    }
    return service;
  }

  updateAccessoryInformation(accessory, device) {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;
    const infoService = accessory.getService(Service.AccessoryInformation);

    if (infoService) {
      infoService
        .setCharacteristic(Characteristic.Manufacturer, device.attributes?.manufacturer || 'IKEA / Sonoff')
        .setCharacteristic(Characteristic.Model, device.attributes?.model || device.deviceType || 'Unknown')
        .setCharacteristic(Characteristic.SerialNumber, device.attributes?.serialNumber || device.id)
        .setCharacteristic(Characteristic.FirmwareRevision, device.attributes?.firmwareVersion || '1.0.0');
    }
  }

  // --- TERMOSTAT ---
  setupThermostat(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Termostat';
    const temp = device.attributes?.currentTemperature || 20;
    const humidity = device.attributes?.currentRH;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie Termostatu: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);

    const thermostatService = this.getOrCreateService(accessory, Service.Thermostat, name);

    thermostatService.setCharacteristic(Characteristic.TargetTemperature, 21);

    thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [Characteristic.TargetHeatingCoolingState.OFF]
      });

    if (!thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).listeners('set').length) {
      thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .onSet(() => {
          setTimeout(() => {
            thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
            thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
          }, 50);
        });
    }

    thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
    thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);

    thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, temp);

    if (humidity !== undefined) {
      thermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }
  }

  // --- CZUJNIK OBECNOŚCI ---
  setupOccupancySensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Obecności';
    const isDetected = device.attributes?.isDetected || false;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie Czujnika Obecności: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);

    const service = this.getOrCreateService(accessory, Service.OccupancySensor, name);
    const state = isDetected 
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED 
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;

    service.updateCharacteristic(Characteristic.OccupancyDetected, state);
  }

  // --- PILOT SOUND CONTROLLER (PROGRAMMABLE SWITCH) ---
  setupSoundController(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Remote 10';

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Rejestracja pilota SYMFONISK: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);

      const buttonService = accessory.addService(Service.StatelessProgrammableSwitch, name);
      buttonService.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .setProps({
          validValues: [
            Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
            Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
          ]
        });

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);
  }
}
