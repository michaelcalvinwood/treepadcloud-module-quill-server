exports.pretty = v => console.log(JSON.stringify(v, null, 4));
exports.j = str => JSON.stringify(str, null, 4);
const eventList = ['clickLoginSubmit']

exports.events = (io, socket, events, info) => {
    io.to(socket.id).emit('monitorEvents', JSON.stringify(events), JSON.stringify(info));
}
