// Test fixture only. This listener is hard-coded to IPv4 loopback.
// Compatible with the C# compiler supplied with Windows PowerShell 5.1.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace ModbusArpScanner.Tests
{
    public sealed class MockModbusServer : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Thread acceptThread;
        private readonly object sync = new object();
        private readonly List<TcpClient> clients = new List<TcpClient>();
        private readonly List<Thread> workers = new List<Thread>();
        private readonly List<int> units = new List<int>();
        private readonly List<int> functions = new List<int>();
        private volatile bool stopping;
        private int requestCount;
        private int connectionCount;
        private bool allReadOnly = true;

        public MockModbusServer(string mode)
        {
            Mode = mode;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            acceptThread = new Thread(AcceptLoop);
            acceptThread.IsBackground = true;
            acceptThread.Start();
        }

        public string Mode { get; private set; }
        public int Port { get; private set; }
        public int RequestCount { get { lock (sync) { return requestCount; } } }
        public int ConnectionCount { get { lock (sync) { return connectionCount; } } }
        public int ActiveConnections { get { lock (sync) { return clients.Count; } } }
        public bool AllRequestsReadOnly { get { lock (sync) { return allReadOnly; } } }
        public int[] UnitsSeen { get { lock (sync) { return units.ToArray(); } } }
        public int[] FunctionsSeen { get { lock (sync) { return functions.ToArray(); } } }

        private void AcceptLoop()
        {
            while (!stopping)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch (SocketException) { break; }
                catch (ObjectDisposedException) { break; }
                lock (sync)
                {
                    if (stopping) { client.Close(); break; }
                    connectionCount++;
                    clients.Add(client);
                }
                Thread worker = new Thread(delegate() { HandleClient(client); });
                worker.IsBackground = true;
                lock (sync) { workers.Add(worker); }
                worker.Start();
            }
        }

        private static byte[] ReadExactly(NetworkStream stream, int size)
        {
            byte[] buffer = new byte[size];
            int offset = 0;
            while (offset < size)
            {
                int read = stream.Read(buffer, offset, size - offset);
                if (read == 0) { throw new EndOfStreamException(); }
                offset += read;
            }
            return buffer;
        }

        private void HandleClient(TcpClient client)
        {
            try
            {
                using (NetworkStream stream = client.GetStream())
                {
                    stream.ReadTimeout = 5000;
                    stream.WriteTimeout = 1000;
                    while (!stopping)
                    {
                        byte[] header = ReadExactly(stream, 7);
                        int length = (header[4] << 8) | header[5];
                        if (length < 2 || length > 254) { break; }
                        byte[] pdu = ReadExactly(stream, length - 1);
                        int fc = pdu[0];
                        int unit = header[6];
                        bool safe = IsAllowedRead(pdu) && unit != 0;
                        lock (sync)
                        {
                            requestCount++;
                            units.Add(unit);
                            functions.Add(fc);
                            if (!safe) { allReadOnly = false; }
                        }
                        if (!safe) { break; }

                        if (Mode == "Silent" || (Mode == "Silent255" && unit == 255) ||
                            (Mode == "FC04Only" && fc == 3))
                        {
                            // Do not reply. The client must enforce its own deadline.
                            continue;
                        }
                        if (Mode == "Banner")
                        {
                            byte[] banner = Encoding.ASCII.GetBytes("HTTP/1.0 200 OK\r\n\r\nLinux test fixture\r\n");
                            stream.Write(banner, 0, banner.Length);
                            break;
                        }

                        byte[] reply = BuildPdu(pdu, unit);
                        if (Mode == "WrongFunction") { reply[0] = 0x7F; }
                        if (Mode == "WrongByteCount" && (fc == 3 || fc == 4) && reply[0] == fc)
                        {
                            reply[1] = 0x04;
                        }
                        byte[] packet = new byte[7 + reply.Length];
                        packet[0] = header[0];
                        packet[1] = header[1];
                        packet[4] = (byte)((reply.Length + 1) >> 8);
                        packet[5] = (byte)((reply.Length + 1) & 255);
                        packet[6] = header[6];
                        Array.Copy(reply, 0, packet, 7, reply.Length);

                        if (Mode == "WrongTransaction") { packet[1] ^= 0x01; }
                        if (Mode == "WrongProtocol") { packet[3] = 0x01; }
                        if (Mode == "WrongUnit") { packet[6] ^= 0x01; }
                        if (Mode == "OversizedLength") { packet[4] = 0xFF; packet[5] = 0xFF; }
                        if (Mode == "UndersizedLength") { packet[4] = 0; packet[5] = 1; }
                        if (Mode == "Truncated")
                        {
                            stream.Write(packet, 0, packet.Length - 1);
                            break;
                        }
                        if (Mode == "Fragmented" || Mode == "SlowTrickle")
                        {
                            int pause = Mode == "Fragmented" ? 5 : 100;
                            for (int i = 0; i < packet.Length && !stopping; i++)
                            {
                                stream.Write(packet, i, 1);
                                if (i < packet.Length - 1) { Thread.Sleep(pause); }
                            }
                        }
                        else { stream.Write(packet, 0, packet.Length); }
                        if (Mode == "CloseAfterReply") { break; }
                    }
                }
            }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                client.Close();
                lock (sync) { clients.Remove(client); }
            }
        }

        private byte[] BuildPdu(byte[] request, int unit)
        {
            byte fc = request[0];
            if (Mode == "IdentityOnly")
            {
                if (fc == 43)
                {
                    return new byte[] { 43, 14, 1, 1, 0, 0, 1, 0, 4, 65, 99, 109, 101 };
                }
                if (fc == 17) { return new byte[] { 17, 2, 42, 255 }; }
                return new byte[] { (byte)(fc | 0x80), 2 };
            }
            if (Mode == "ExceptionOnly" || (Mode == "Exception255" && unit == 255))
            {
                return new byte[] { (byte)(fc | 0x80), (byte)((fc == 3 || fc == 4) ? 2 : 1) };
            }
            if (Mode == "GatewayFault")
            {
                return new byte[] { (byte)(fc | 0x80), (byte)((fc == 3 || fc == 4) ? 11 : 1) };
            }
            if (Mode == "RejectFC03" && fc == 3)
            {
                return new byte[] { 0x83, 1 };
            }
            if (fc == 3 || fc == 4)
            {
                int address = (request[1] << 8) | request[2];
                int quantity = (request[3] << 8) | request[4];
                byte[] response = new byte[2 + quantity * 2];
                response[0] = fc;
                response[1] = (byte)(quantity * 2);
                for (int i = 0; i < quantity; i++)
                {
                    int value = address + i == 0 ? 0 : 100 + address + i;
                    response[2 + 2 * i] = (byte)(value >> 8);
                    response[3 + 2 * i] = (byte)(value & 255);
                }
                return response;
            }
            return new byte[] { (byte)(fc | 0x80), 1 };
        }

        private static bool IsAllowedRead(byte[] pdu)
        {
            if (pdu.Length == 0) { return false; }
            if (pdu[0] == 3 || pdu[0] == 4)
            {
                if (pdu.Length != 5) { return false; }
                int address = (pdu[1] << 8) | pdu[2];
                int quantity = (pdu[3] << 8) | pdu[4];
                return quantity >= 1 && quantity <= 125 && address + quantity <= 65536;
            }
            if (pdu[0] == 17) { return pdu.Length == 1; }
            return pdu.Length == 4 && pdu[0] == 43 && pdu[1] == 14 && pdu[2] == 1 && pdu[3] == 0;
        }

        public void Dispose()
        {
            if (stopping) { return; }
            stopping = true;
            listener.Stop();
            lock (sync)
            {
                foreach (TcpClient client in clients.ToArray()) { client.Close(); }
            }
            acceptThread.Join(1000);
            Thread[] copy;
            lock (sync) { copy = workers.ToArray(); }
            foreach (Thread worker in copy) { worker.Join(1000); }
        }
    }
}
