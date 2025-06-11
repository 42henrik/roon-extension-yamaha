"use strict"
// 0.4.0 First release with according to Yamaha YXC specification (based on 0.0.11)
// 0.4.1 fixed input tests

var RoonApi                 = require("node-roon-api"),
    RoonApiStatus           = require("node-roon-api-status"),
    RoonApiSettings         = require("node-roon-api-settings"),
    RoonApiSourceControl    = require("node-roon-api-source-control"),
    RoonApiVolumeControl    = require("node-roon-api-volume-control"),
    YamahaYXC               = require("./yxc_api_cmd_modified");

//  YamahaYXC               = require("yamaha-yxc-nodejs").YamahaYXC;

var roon = new RoonApi({
    extension_id:        "info.aha-may.yamaha",
    display_name:        "Yamaha Control",
    display_version:     "0.4.1",
    publisher:           'Aha-May',
    email:               'henrik.jeppsson@42info.se',
    website:             'https://github.com/42henrik/roon-extension-yamaha'
});

var svc_status   = new RoonApiStatus(roon);
var svc_volume   = new RoonApiVolumeControl(roon);
var svc_source   = new RoonApiSourceControl(roon);
var svc_settings = new RoonApiSettings(roon);

var yamaha = {
    "default_device_ip": "",
    "default_device_name": "Yamaha",
    "default_zone": "main",
    "default_input": "av1",
    "volume": -50,
};

var setupReady = false;
var isYamaha = false;
var volTimeout = null;

var mysettings = roon.load_config("settings") || {
    device_ip:      yamaha.default_device_ip,
    device_url:     "",
    input:          yamaha.default_input,
    inputName:      "",
    zone:           yamaha.default_zone,
    zoneName:       "",
    device_name:    yamaha.default_device_name,
    zone_list:      [],
    zone_input_list:[]
}
// get argv from to ID 
var display_name_id = "";
if (!process.argv[2] == ""){
    display_name_id = process.argv[2];
};

function makelayout(settings) {
    var l = {
        values:    settings,
        layout:    [],
        has_error: false,
    };
    var key = 0;

    l.layout.push({
        type:    "string",
        title:   "Device name",
        subtitle: "",
        setting: "device_name"
    });

    let z = {
        type:      "dropdown",
        title:     "Zone",
        subtitle:  "Zone on Yamaha",
        values:    mysettings.zone_list,
        setting:   "zone",
    };
    
    if (settings.zone == 'main') {
        key = 0;
    } else {
        key = Number(settings.zone.match(/\d/)[0]) - 1; // zone number
    }
    settings.zoneName = (settings.zone_list.find(z1 => z1.value === settings.zone)).title;

    let i = {
        type:       "dropdown",
        title:      "Input",
        subtitle:   "Roon input",
        values:     settings.zone_input_list[key]["input_list"],
        setting:    "input"
    };

    if (!settings.zone_input_list[key]["input_list"].find(i1 => i1.value === settings.input)) {
        settings.input = settings.zone_input_list[key]["input_list"][0].value;
    }
    settings.inputName = (settings.zone_input_list[key]["input_list"].find(i1 => i1.value === settings.input)).title;

    l.layout.push(z);
    l.layout.push(i);

    return l;
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            mysettings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", mysettings);
        }
    }
});

svc_status.set_status("Initializing.", false)

function update_status() {
    if (yamaha.av && mysettings.device_name && mysettings.inputName) {
        svc_status.set_status(mysettings.device_name + " present at " + yamaha.av.ip + ". Input: " + mysettings.inputName + " in " + mysettings.zoneName, false);    
    } else if (yamaha.av && mysettings.device_name && yamaha.av.ip) {
        svc_status.set_status(mysettings.device_name + " present at " + yamaha.av.ip , false);    
    } else if (yamaha.av) {
        svc_status.set_status("Found Yamaha device. Discovering…", false);    
    } else {
        svc_status.set_status("Could not find Yamaha device during status update.", true)
    }
}

function check_status() {
    if (yamaha.av && setupReady) {
        yamaha.av.getStatus(mysettings.zone)
        .then( (result) => {
            // exit if a change through roon is in progress
            if (volTimeout) return;
            // should get current state first, to see if update is necessary
                yamaha.svc_volume.update_state({
                    volume_value: (result.volume - 161) / 2,   // (result.volume/2) - 80.5,
                    is_muted: result.mute
            });
            yamaha.source_control.update_state({
                status: (result.power == "on")? "selected": "standby"
            });
        
            update_status()
        })
        .catch( (error) => {
            svc_status.set_status("Could not find Yamaha device during status check.", true);
        });
    }
}
async function get_yamaha_props() {
    try {
        let zoneNames = [];
        let inputNames = [];
        let soundProgramNames = [];  // currenly not used

        await yamaha.av.getNameText().then(function(result) {
            // console.table(result);
            zoneNames = result.zone_list;
            inputNames = result.input_list;
            soundProgramNames = result.sound_program_list;
        });
    
        await yamaha.av.getFeatures().then(function(result) {
            mysettings.zone_list = [];
            mysettings.zone_input_list = [];
            mysettings.input_list = [];
    
            let zones = result.zone;
            for (let key1 in zones) {
                // get zones
                // console.log(key1 + "----", zones[key1].id);
                if (zones[key1].id) {
                    let zoneName = (zones[key1].id == "main") ? "main zone" : zones[key1].id;
                    zoneName = zoneName.charAt(0).toUpperCase() + zoneName.slice(1) +": " + zoneNames[key1].text;
                    mysettings.zone_list.push({
                        "title": zoneName, 
                        "value": zones[key1].id
                    })
                    // get inputs for each zone
                    let inputs = result.zone[key1].input_list;
                    // console.table(inputs);
                    let input_list = [];
                    for (let key in inputs) {
                        // console.log(key + ": " + inputs[key]); //(inputs[key].substr(0, 2) = 'av') || (inputs[key].substr(0, 5) = 'audio' ) || 
                        if (inputs[key].includes('av') || inputs[key].includes('audio') || inputs[key].includes('airplay') || inputs[key].includes('hdmi')) {
                                input_list.push({
                                    "title": inputNames.find(inputName => inputName.id === inputs[key]).text,
                                    "value": inputs[key],
                               })
                        }
                    }
                    // console.table(input_list);
                    // add to zone_input_list
                    mysettings.zone_input_list.push({
                        "zone": zones[key1].id,
                        "input_list": input_list
                    })
                }
            }
        }) 
        
    } catch(err) {
        svc_status.set_status("Could not get Yamaha device's properties.", false)
    } 
}

async function setup_yamaha() {
    isYamaha = false;
    setupReady = false;
    
    if (yamaha.av) {
        yamaha.av = undefined;
    }
    if (yamaha.source_control) {
        yamaha.source_control.destroy();
        delete(yamaha.source_control);
    }
    if (yamaha.svc_volume) {
        yamaha.svc_volume.destroy();
        delete(yamaha.svc_volume);
    }

    yamaha.av = new YamahaYXC(mysettings.device_ip);
    // console.table(yamaha.av);
    // check if Yamaha is availble at the given ip adress
    if (mysettings.device_ip != "") {
        await yamaha.av.getXML('http://' + mysettings.device_ip + ':49154/MediaRenderer/desc.xml')
        .then((result) => {
            isYamaha = result[2];
            if (isYamaha) {
                mysettings.device_url = result[0];
                mysettings.device_name = "Yamaha " + result[1];
            }
        })
        .catch( (error) => {
            isYamaha = false;
            svc_status.set_status("Could not find Yamaha device at the ip adress.", false)
        }); 
    }
    svc_status.set_status("Could not find Yamaha device at the given ip adress. Searching...", false);

    // Yamaha is not found > Discover
    if (!isYamaha) {
        await yamaha.av.discover()
        .then( (result) => {
            for (let key in result) {
                if (result[key].isYamaha) {
                    yamaha.av.ip = result[key].ip;
                    mysettings.device_ip = yamaha.av.ip;
                    mysettings.device_url = result[key].model;
                    mysettings.device_name = "Yamaha " + result[key].name;
                    isYamaha = result[key].isYamaha;
                    break; // break after first occurance
                }
            }
            if (!isYamaha) {
                yamaha.av = undefined;
                svc_status.set_status("Could not find Yamaha device to setup.", true);
            }
        })
        .catch( (error) => {
            yamaha.av = undefined;
            isYamaha = false;
            svc_status.set_status("Could not find Yamaha device to setup.", true)
        })
    }

    if (isYamaha) {
        await get_yamaha_props();
        setupReady = true;
    }
    update_status();

    yamaha.svc_volume = svc_volume.new_device({
        state: {
            display_name: mysettings.device_name,
            volume_type:  "db",
            volume_min:   -80,
            volume_max:   -10,
            volume_value: -80,
            volume_step:  0.5,
            is_muted:     0
        },
        set_volume: function (req, mode, value) {
            let newvol = mode == "absolute" ? value : (yamaha.volume + value);
            if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
            else if (newvol > this.state.volume_max) newvol = this.state.volume_max;
            yamaha.svc_volume.update_state({ volume_value: newvol });
            
            clearTimeout(volTimeout);
            volTimeout = setTimeout(() => {
                yamaha.av.setVolumeTo((2 * value) + 161, mysettings.zone);
                clearTimeout(volTimeout);
                volTimeout = null;
            }, 500)
            req.send_complete("Success");
        },
        set_mute: function (req, action) {
            let is_muted = !this.state.is_muted;
            yamaha.av.mute(is_muted, mysettings.zone)
            yamaha.svc_volume.update_state({ is_muted: is_muted });
            req.send_complete("Success");
        }

    });

    yamaha.source_control = svc_source.new_device({
        state: {
            display_name: mysettings.device_name,
            supports_standby: true,
            status: "selected",
        },
        convenience_switch: function (req) {
            yamaha.av.power("on", mysettings.zone);
            yamaha.av.setInput(mysettings.input, mysettings.zone);
            req.send_complete("Success");
        },
        standby: function (req) {
            let state = this.state.status;
            this.state.status = (state == "selected")? "standby" : "selected";
            yamaha.av.power((state == "selected")? "standby": "on", mysettings.zone);
            req.send_complete("Success");
        }
    });
}

// ---
let os = require("os");
let hostname = os.hostname().split(".")[0];
let ipaddress = os.ip;
let ni = os.networkInterfaces();

roon.extension_reginfo.extension_id += (display_name_id == "" ? "" : ("." + display_name_id.toLowerCase())) + "." + hostname.toLowerCase();
roon.extension_reginfo.display_name += (display_name_id == "" ? "" : ": " + display_name_id) + " @" + hostname;
if (mysettings.device_ip) {
    roon.extension_reginfo.website = "http://" + mysettings.device_ip; // + "/setup";
}
console.log("LET'S GO...", roon.extension_reginfo.display_name, roon.extension_reginfo.extension_id, roon.extension_reginfo.website);

roon.init_services({
    provided_services: [ svc_status, svc_settings, svc_volume, svc_source ]
});

setInterval(() => { 
    if (!yamaha.av) 
        setup_yamaha(); 
}, 1000);

setInterval(() => { 
    if (yamaha.av && setupReady) 
        check_status(); 
}, 5000);

roon.start_discovery();
