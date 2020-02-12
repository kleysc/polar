import * as electron from 'electron';
import * as fs from 'fs-extra';
import { join } from 'path';
import * as compose from 'docker-compose';
import Dockerode from 'dockerode';
import os from 'os';
import { dockerService } from 'lib/docker';
import { Network, NetworksFile } from 'types';
import { initChartFromNetwork } from 'utils/chart';
import { networksPath } from 'utils/config';
import { APP_VERSION, defaultRepoState, DOCKER_REPO } from 'utils/constants';
import * as files from 'utils/files';
import { createNetwork } from 'utils/network';
import { getNetwork } from 'utils/tests';

jest.mock('dockerode');
jest.mock('os');
jest.mock('utils/files', () => ({
  write: jest.fn(),
  read: jest.fn(),
  exists: jest.fn(),
}));

const mockOS = os as jest.Mocked<typeof os>;
const filesMock = files as jest.Mocked<typeof files>;
const composeMock = compose as jest.Mocked<typeof compose>;
const electronMock = electron as jest.Mocked<typeof electron>;
const mockDockerode = (Dockerode as unknown) as jest.Mock<Dockerode>;

describe('DockerService', () => {
  let network: Network;
  // default response of docker calls for mocks
  const mockResult = { err: '', out: '', exitCode: 0 };

  beforeEach(() => {
    network = getNetwork();
  });

  it('should populate env vars with compose commands', async () => {
    Object.defineProperty(electronMock.remote.process, 'env', {
      get: () => ({
        __TESTVAR: 'TESTVAL',
      }),
    });
    await dockerService.getVersions();
    expect(composeMock.version).toBeCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ __TESTVAR: 'TESTVAL' }),
      }),
      undefined,
    );
  });

  it('should populate UID/GID env vars when running on linux', async () => {
    mockOS.platform.mockReturnValue('linux');
    mockOS.userInfo.mockReturnValue({ uid: '999', gid: '999' } as any);
    await dockerService.getVersions();
    expect(composeMock.version).toBeCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ USERID: '999', GROUPID: '999' }),
      }),
      undefined,
    );
  });

  describe('detecting versions', () => {
    const dockerVersion = mockDockerode.prototype.version;
    const composeVersion = composeMock.version;

    it('should get both versions successfully', async () => {
      dockerVersion.mockResolvedValue({ Version: '1.2.3' });
      composeVersion.mockResolvedValue({ ...mockResult, out: '4.5.6' });
      const versions = await dockerService.getVersions(true);
      expect(versions.docker).toBe('1.2.3');
      expect(versions.compose).toBe('4.5.6');
    });

    it('should return default values if both throw errors', async () => {
      dockerVersion.mockRejectedValue(new Error('docker-error'));
      composeVersion.mockRejectedValue(new Error('compose-error'));
      const versions = await dockerService.getVersions();
      expect(versions.docker).toBe('');
      expect(versions.compose).toBe('');
    });

    it('should return compose version if docker version fails', async () => {
      dockerVersion.mockRejectedValue(new Error('docker-error'));
      composeVersion.mockResolvedValue({ ...mockResult, out: '4.5.6' });
      const versions = await dockerService.getVersions();
      expect(versions.docker).toBe('');
      expect(versions.compose).toBe('4.5.6');
    });

    it('should return docker version if docker compose fails', async () => {
      dockerVersion.mockResolvedValue({ Version: '1.2.3' });
      composeVersion.mockRejectedValue(new Error('compose-error'));
      const versions = await dockerService.getVersions();
      expect(versions.docker).toBe('1.2.3');
      expect(versions.compose).toBe('');
    });

    it('should throw an error if docker version fails', async () => {
      dockerVersion.mockRejectedValue(new Error('docker-error'));
      composeVersion.mockResolvedValue({ ...mockResult, out: '4.5.6' });
      await expect(dockerService.getVersions(true)).rejects.toThrow('docker-error');
    });

    it('should throw an error if compose version fails', async () => {
      dockerVersion.mockResolvedValue({ Version: '1.2.3' });
      composeVersion.mockRejectedValue({ err: 'compose-error' });
      await expect(dockerService.getVersions(true)).rejects.toThrow('compose-error');
    });
  });

  describe('getting images', () => {
    const dockerListImages = mockDockerode.prototype.listImages;
    const polar = (name: string) => `${DOCKER_REPO}/${name}`;
    const mapResponse = (names: string[]) => names.map(name => ({ RepoTags: [name] }));

    it('should return a list of all docker images', async () => {
      dockerListImages.mockResolvedValue(mapResponse([polar('aaa'), polar('bbb')]));
      expect(await dockerService.getImages()).toEqual([polar('aaa'), polar('bbb')]);
    });

    it('should return images that do not start with the prefix', async () => {
      dockerListImages.mockResolvedValue(mapResponse(['other1', polar('aaa'), 'other2']));
      expect(await dockerService.getImages()).toEqual(['other1', polar('aaa'), 'other2']);
    });

    it('should return an empty list if the fetch fails', async () => {
      dockerListImages.mockRejectedValue(new Error('test-error'));
      expect(await dockerService.getImages()).toEqual([]);
    });

    it('should handle untagged images', async () => {
      dockerListImages.mockResolvedValue([
        ...mapResponse([polar('aaa'), polar('bbb')]),
        { RepoTags: undefined },
      ]);
      expect(await dockerService.getImages()).toEqual([polar('aaa'), polar('bbb')]);
    });
  });

  describe('saving data', () => {
    it('should save the docker-compose.yml file', () => {
      dockerService.saveComposeFile(network);

      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining('version:'),
      );

      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining('services:'),
      );
    });

    it('should save with the bitcoin node in the compose file', () => {
      dockerService.saveComposeFile(network);
      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining(
          `container_name: polar-n1-${network.nodes.bitcoin[0].name}`,
        ),
      );
    });

    it('should save with the lnd node in the compose file', () => {
      dockerService.saveComposeFile(network);
      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining(
          `container_name: polar-n1-${network.nodes.lightning[0].name}`,
        ),
      );
    });

    it('should save the lnd node with the first bitcoin node as backend', () => {
      const net = createNetwork({
        id: 1,
        name: 'my network',
        lndNodes: 1,
        clightningNodes: 0,
        bitcoindNodes: 1,
        repoState: defaultRepoState,
      });
      net.nodes.lightning[0].backendName = 'invalid';
      dockerService.saveComposeFile(net);
      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining(
          `container_name: polar-n1-${network.nodes.lightning[0].name}`,
        ),
      );
    });

    it('should save the c-lightning node with the first bitcoin node as backend', () => {
      const net = createNetwork({
        id: 1,
        name: 'my network',
        lndNodes: 0,
        clightningNodes: 1,
        bitcoindNodes: 1,
        repoState: defaultRepoState,
      });
      net.nodes.lightning[0].backendName = 'invalid';
      dockerService.saveComposeFile(net);
      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining(
          `container_name: polar-n1-${network.nodes.lightning[0].name}`,
        ),
      );
    });

    it('should not save unknown lightning implementation', () => {
      network.nodes.lightning[0].implementation = 'eclair';
      dockerService.saveComposeFile(network);
      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining('docker-compose.yml'),
        expect.not.stringContaining(
          `container_name: polar-n1-${network.nodes.lightning[0].name}`,
        ),
      );
    });

    it('should save a list of networks to disk', () => {
      dockerService.saveNetworks({ version: '0.1.0', networks: [network], charts: {} });
      expect(filesMock.write).toBeCalledWith(
        expect.stringContaining(join('networks', 'networks.json')),
        expect.stringContaining(`"name": "${network.name}"`),
      );
    });
  });

  describe('loading data', () => {
    const createLegacyNetworksFile = () => {
      const net = createNetwork({
        id: 1,
        name: 'my network',
        lndNodes: 2,
        clightningNodes: 1,
        bitcoindNodes: 1,
        repoState: defaultRepoState,
      });
      const chart = initChartFromNetwork(net);
      net.path = 'ELECTRON_PATH[userData]/data/networks/1';
      delete net.nodes.bitcoin[0].peers;
      const { name } = net.nodes.bitcoin[0];
      delete chart.nodes[name].ports['peer-left'];
      delete chart.nodes[name].ports['peer-right'];
      const fileData: NetworksFile = {
        version: '0.0.0',
        networks: [net],
        charts: {
          [network.id]: chart,
        },
      };
      return JSON.stringify(fileData);
    };

    it('should load the list of networks from disk', async () => {
      filesMock.exists.mockResolvedValue(true);
      const fileData = `{ "version": "${APP_VERSION}", "networks": [], "charts": {} }`;
      filesMock.read.mockResolvedValue(fileData);
      const { networks } = await dockerService.loadNetworks();
      expect(networks.length).toBe(0);
      expect(filesMock.read).toBeCalledWith(
        expect.stringContaining(join('networks', 'networks.json')),
      );
    });

    it('should return an empty list if no networks are saved', async () => {
      filesMock.exists.mockResolvedValue(false);
      const { networks } = await dockerService.loadNetworks();
      expect(Array.isArray(networks)).toBe(true);
      expect(networks.length).toBe(0);
    });

    it('should copy networks folder from an older version', async () => {
      filesMock.exists.mockResolvedValueOnce(true); // legacy path
      filesMock.exists.mockResolvedValueOnce(false); // current path before copy
      filesMock.exists.mockResolvedValueOnce(true); // current path after copy
      filesMock.read.mockResolvedValue(createLegacyNetworksFile());
      const { networks, version } = await dockerService.loadNetworks();
      expect(version).toEqual(APP_VERSION);
      expect(networks.length).toBe(1);
      expect(networks[0].path).toEqual(join(networksPath, `${networks[0].id}`));
    });

    it('should migrate network data from an older version', async () => {
      filesMock.exists.mockResolvedValue(true);
      filesMock.read.mockResolvedValue(createLegacyNetworksFile());
      const { networks, charts, version } = await dockerService.loadNetworks();
      expect(version).toEqual(APP_VERSION);
      expect(networks[0].path).toEqual(join(networksPath, `${networks[0].id}`));
      const btcNode = networks[0].nodes.bitcoin[0];
      expect(btcNode.peers).toEqual([]);
      const chart = charts[networks[0].id];
      expect(chart.nodes[btcNode.name].ports['peer-left']).toBeDefined();
      expect(chart.nodes[btcNode.name].ports['peer-right']).toBeDefined();
    });
  });

  describe('executing commands', () => {
    it('should call compose.upAll when a network is started', async () => {
      composeMock.upAll.mockResolvedValue(mockResult);
      await dockerService.start(network);
      expect(composeMock.upAll).toBeCalledWith(
        expect.objectContaining({ cwd: network.path }),
        undefined,
      );
    });

    it('should create volume dirs when the network is started', async () => {
      composeMock.upAll.mockResolvedValue(mockResult);
      await dockerService.start(network);
      expect(fs.ensureDir).toBeCalledTimes(6);
    });

    it('should call compose.down when a network is stopped', async () => {
      composeMock.down.mockResolvedValue(mockResult);
      await dockerService.stop(network);
      expect(composeMock.down).toBeCalledWith(
        expect.objectContaining({ cwd: network.path }),
        undefined,
      );
    });

    it('should call compose.upOne when a node is started', async () => {
      composeMock.upOne.mockResolvedValue(mockResult);
      const node = network.nodes.lightning[0];
      await dockerService.startNode(network, node);
      expect(composeMock.upOne).toBeCalledWith(
        node.name,
        expect.objectContaining({ cwd: network.path }),
      );
    });

    it('should call compose.stopOne when a node is stopped', async () => {
      composeMock.stopOne.mockResolvedValue(mockResult);
      const node = network.nodes.lightning[0];
      await dockerService.stopNode(network, node);
      expect(composeMock.stopOne).toBeCalledWith(
        node.name,
        expect.objectContaining({ cwd: network.path }),
      );
    });

    it('should call compose.stopOne and compose.rm when a node is removed', async () => {
      composeMock.stopOne.mockResolvedValue(mockResult);
      composeMock.rm.mockResolvedValue(mockResult);
      const node = network.nodes.lightning[0];
      await dockerService.removeNode(network, node);
      expect(composeMock.stopOne).toBeCalledWith(
        node.name,
        expect.objectContaining({ cwd: network.path }),
      );
      expect(composeMock.rm).toBeCalledWith(
        expect.objectContaining({ cwd: network.path }),
        undefined,
      );
    });

    it('should reformat thrown exceptions', async () => {
      const err = 'oops, didnt work';
      composeMock.upAll.mockRejectedValueOnce({ err });
      await expect(dockerService.start(network)).rejects.toThrow(err);
    });

    it('should pass through thrown exceptions', async () => {
      composeMock.upAll.mockRejectedValueOnce({ errno: 'oops, didnt work' });
      await expect(dockerService.start(network)).rejects.toThrow('oops, didnt work');
    });

    it('should not fail if electron.remote is undefined', async () => {
      Object.defineProperty(electronMock.remote, 'process', { get: () => undefined });
      composeMock.upAll.mockResolvedValue(mockResult);
      await dockerService.start(network);
      expect(composeMock.upAll).toBeCalledWith(
        expect.objectContaining({ cwd: network.path }),
        undefined,
      );
      Object.defineProperty(electronMock.remote, 'process', { get: () => ({ env: {} }) });
    });
  });
});
