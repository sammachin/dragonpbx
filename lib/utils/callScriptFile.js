const Handlebars = require('handlebars');
const moment = require('moment-timezone');
const fs = require('fs').promises;
const { FILE_PATH } = require('../../settings');

// Extend the Date prototype to add timezone functionality
Date.prototype.inTimezone = function(timezone) {
  return moment(this).tz(timezone);
};

function dateObject(tz){
  const now = new Date();
    return {
    "day" : now.inTimezone(tz).format('DD'),
    "month": now.inTimezone(tz).format('MM'),
    "year": now.inTimezone(tz).format('YYYY'),
    "dayname" : now.inTimezone(tz).format('dddd'),
    "dayofweek" : now.inTimezone(tz).format('d'),
    "hour" : now.inTimezone(tz).format('H'),
    "minute" : now.inTimezone(tz).format('mm'),
    "seconds" : now.inTimezone(tz).format('ss'),
    "time" : now.inTimezone(tz).format('hh:mm'),
  }
}

Handlebars.registerHelper(
  'isDay', function(tz) {
    const date = dateObject(tz)
    let days = [];
    for (let i = 1; i < arguments.length - 1; i++) {
      days.push(arguments[i]);
    }
    return days.includes(date.dayname)
  } 
);

Handlebars.registerHelper(
  'inHours', function(tz, start, end) {
    const now = dateObject(tz).time
    start_moment = moment(start, 'hh:mm').tz(tz)
    end_moment = moment(end, 'hh:mm').tz(tz)
    return moment(now, 'hh:mm').isBetween(start_moment, end_moment)
  } 
);

Handlebars.registerHelper({
  eq: (v1, v2) => v1 === v2,
  ne: (v1, v2) => v1 !== v2,
  lt: (v1, v2) => v1 < v2,
  gt: (v1, v2) => v1 > v2,
  lte: (v1, v2) => v1 <= v2,
  gte: (v1, v2) => v1 >= v2,
  and() {
      return Array.prototype.every.call(arguments, Boolean);
  },
  or() {
      return Array.prototype.slice.call(arguments, 0, -1).some(Boolean);
  }
});


const fileRequest = async(logger, filename, req) => {
    const body = {
      domain: req.locals.domain,
      from: req.locals.fromUri.user,
      to: req.locals.toUri.user,
      callId: req.locals.callId,
      sourceAddress: req.source_address,
      headers: req.headers,
      source: req.locals.trunk ? req.locals.trunk : 'client',
      refer: req.locals.refer ? true : false,
      count: req.locals.count
    };
try {
    const templateSource = await fs.readFile(FILE_PATH+'/'+filename, 'utf8');
    const template = Handlebars.compile(templateSource);
    const data = {...body, date: dateObject('UTC')}
    const rendered = template(data);
    const output=JSON.parse(rendered)
    logger.debug(output, 'renderedCallScript')
    return output
} catch (err) {
    logger.error('Error proccessing file:', err);
}
}

module.exports =  {fileRequest}