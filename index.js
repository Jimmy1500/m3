const { Bus, App, Cluster, Config } = require('./src');
const { default: axios } = require('axios');
const hash = require('object-hash');

// const bus = new Bus();
// bus.connect({ port: Config.REDIS.PORT, host: Config.REDIS.HOST, db: 0, /* username: , password: */ });

// bus.push(Config.REDIS.TOPIC.M3_DATA, { user: 'jimmy1500', callback: 'http://localhost:5000/webhook' });
// bus.push(Config.REDIS.TOPIC.M3_USER, { user: 'octocat' });
// bus.push(Config.REDIS.TOPIC.M3_REPO, { user: 'octocat' });
// bus.poll([...Object.values(Config.REDIS.TOPIC)], [ 0, 0, 0 ], 10, 0).then(s  => { console.log('streams: %O', s); bus.flush(); });

// bus.set('test_cache', ['a', 'b', 'c'], false).then(
//     bus.get('test_cache', false).then( val => {
//         console.log('test_cache retrieved: %O', val);
//         bus.del('test_cache');
//         console.log('test_cache deleted: %O', val);
//         bus.disconnect();
//     })
// );

async function cacheOf(bus, topic, event, expiry = 0, url = null) {
    const key   = hash.sha1({ topic: topic, body: event?.body });
    const cache = await bus.get(key);
    if ( cache ) {
        const cached = JSON.parse(cache);
        if ( !cached?.data || !cached?.expiry ) {
            await bus.del(key);
            console.warn(`cache %O purged, no data or expiry specified`, key);
        } else if ( cached.expiry > Date.now() ) {
            console.warn(`cache %O valid, expire in %Os`, key, (cached.expiry - Date.now())/1000);
            return cached?.data;
        } else { console.warn(`cache %O expired`, key); }
    } else { console.warn(`no cache %O`, key); }

    // refresh cache if source api url is specified
    if ( url?.length ) {
        const res = await axios.get(url);
        await bus.set(key, { data: res?.data, expiry: Date.now() + expiry });
        console.log(`(%O) %O, cache %O updated, expire in %Os`, res?.status, url, key, expiry/1000);
        return res?.data;
    }
    return null;
}

async function handler(bus, topic, event, expiry) {
    if ( !(bus instanceof Bus)      ) { throw new TypeError('bus must be instance of Bus');     }
    if ( !(event instanceof Object) ) { throw new TypeError("event must be instance of object");}
    if ( !event?.body?.length       ) { throw new TypeError('no body specified in event');      }

    const body = JSON.parse(event?.body);
    if ( !body?.user?.length ) { throw new EvalError('no user specified in event.body'); }
    const user = body.user;

    switch (topic) {
        case Config.REDIS.TOPIC.M3_DATA: {
            if ( !body?.callback?.length ) { throw new EvalError(`callback url not specified per ${topic}.${event.id}`); }

            const user_data = await cacheOf(bus, Config.REDIS.TOPIC.M3_USER, event);
            const repo_data = await cacheOf(bus, Config.REDIS.TOPIC.M3_REPO, event);
            if ( user_data && repo_data ) {
                try {
                    console.log(`POST -> %O...`, body?.callback);
                    const data = { ...user_data, repos: repo_data };
                    const res = await axios.post(body?.callback, data)
                    console.log(`POST -> %O, %O`, body?.callback, res?.status);
                } catch (error) {
                    throw new EvalError(`POST -> ${body?.callback}, ${error.message}`)
                }
            } else {
                if ( !user_data ) { bus.push(Config.REDIS.TOPIC.M3_USER, body); }
                if ( !repo_data ) { bus.push(Config.REDIS.TOPIC.M3_REPO, body); }
                throw new EvalError(`user/repo data no available`);
            }
            break;
        }
        case Config.REDIS.TOPIC.M3_USER: {
            const data = await cacheOf(bus, topic, event, expiry, `${Config.GIT.API_BASE_URL}/${user}`);
            if ( !data ) { throw new EvalError(`no data recovered per ${topic}.${event.id}`); }
            break;
        }
        case Config.REDIS.TOPIC.M3_REPO: {
            const data = await cacheOf(bus, topic, event, expiry, `${Config.GIT.API_BASE_URL}/${user}/repos`);
            if ( !data ) { throw new EvalError(`no data recovered per ${topic}.${event.id}`); }
            break;
        }
        default: {
            console.warn('unrecognized topic: %O, event: %O', topic, event);
            break;
        }
    }
}

function run(duration = 10000) {
    if ( duration < 0 ) { throw new EvalError('duration cannot be < 0'); }

    const cluster = new Cluster(Config.NETWORK_TYPE.SHARED, Config.IDLE_STRATEGY);
    cluster.deploy([
        new App(cluster.network(), Config.REDIS.TOPIC.M3_DATA, 0, Config.POLL_SIZE, Config.BLOCK_ON_EMPTY, 0, handler),
        new App(cluster.network(), Config.REDIS.TOPIC.M3_USER, 0, Config.POLL_SIZE, Config.BLOCK_ON_EMPTY, Config.CACHE.USER_EXPIRY, handler),
        new App(cluster.network(), Config.REDIS.TOPIC.M3_REPO, 0, Config.POLL_SIZE, Config.BLOCK_ON_EMPTY, Config.CACHE.REPO_EXPIRY, handler)
    ]); 

    console.log('running cluster, shutdown in approx...%Os', duration ? duration/1000: 'N/A');

    cluster.run();
    if ( duration ) { cluster.wait(duration).then( _ => cluster.shutdown()); }
}

run(0);