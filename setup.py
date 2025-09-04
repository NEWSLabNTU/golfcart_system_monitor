from setuptools import setup
import os
from glob import glob

package_name = 'autosdv_system_monitor'

setup(
    name=package_name,
    version='1.0.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.launch.yaml')),
        ('share/' + package_name + '/config', glob('config/*.yaml')),
    ],
    package_data={
        package_name: ['templates/*.html'],
    },
    include_package_data=True,
    install_requires=['setuptools'],
    zip_safe=False,
    maintainer='AutoSDV Team',
    maintainer_email='autosdv@example.com',
    description='AutoSDV system monitoring package with web interface for ROS2 topics',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'autosdv_system_monitor_node = autosdv_system_monitor.autosdv_system_monitor_node:main',
        ],
    },
)